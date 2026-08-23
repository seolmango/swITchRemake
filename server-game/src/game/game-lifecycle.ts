/**
 * `RoomLifecyclePort` 구현. 방이 "경기를 시작한다"고 하면 여기서 world를 만들고 스케줄러에 올린다.
 *
 * 방은 world를 모르고 시뮬레이션은 방을 모른다. 둘을 아는 유일한 곳이 이 파일이다.
 */

import type { MatchResultMessage, ViolationSignal } from 'shared';
import { GAMEPLAY } from '../config/gameplay';
import { instantiateMap, type ServerMapBundle } from '../maps/map-loader';
import type { GameStartInfo, Room, RoomLifecyclePort, RoomStartSnapshot } from '../rooms/room';
import type { Scheduler } from '../simulation/scheduler';
import { grantTaggerFrenzy, SkillId, type SkillRequest } from '../simulation/skills';
import { createWorld, emptyStats, type PlayerState } from '../simulation/world';
import { GameSession } from './game-session';
import type { RosterEntry } from './snapshot-view';

export interface GameLifecycleOptions {
    readonly bundle: ServerMapBundle;
    readonly serverId: string;
    readonly buildId: string;
    readonly scheduler: Scheduler;
    readonly lookupRoom: (roomId: string) => Room | null;
    readonly violationSink: (signal: ViolationSignal) => void;
    /** 경기가 끝나면 결과를 내보낸다. Redis outbox가 받는다. */
    readonly onMatchFinished?: (session: GameSession, result: MatchResultMessage) => void;
    /** 테스트에서 고정 seed를 넣기 위한 통로. 기본은 시각 기반이다. */
    readonly makeSeed?: (snapshot: RoomStartSnapshot) => number;
}

export class GameLifecycle implements RoomLifecyclePort {
    readonly #options: GameLifecycleOptions;
    readonly #sessions = new Map<string, GameSession>();

    public constructor(options: GameLifecycleOptions) {
        this.#options = options;
    }

    public session(roomId: string): GameSession | null {
        return this.#sessions.get(roomId) ?? null;
    }

    public startGame(snapshot: RoomStartSnapshot): GameStartInfo {
        const room = this.#options.lookupRoom(snapshot.roomId);
        if (room === null) throw new Error(`start requested for unknown room: ${snapshot.roomId}`);

        const map = instantiateMap(this.#options.bundle, snapshot.mapId);
        const seed = this.#options.makeSeed?.(snapshot) ?? Date.now();
        const players = this.#placePlayers(snapshot, map.tileSize, map.cols);

        const world = createWorld({ map, players, seed });

        // 술래는 world의 PRNG로 고른다. Math.random을 쓰면 리플레이가 같은 경기를 재현하지 못한다.
        const taggerIndex = world.nextRandomInt(players.length);
        const tagger = players[taggerIndex] ?? players[0];
        if (tagger === undefined) throw new Error('cannot start a game with no players');
        tagger.isTagger = true;
        grantTaggerFrenzy(world, tagger);

        const roster: RosterEntry[] = snapshot.playerIds.map((playerId) => ({
            playerId,
            nickname: room.nicknameOf(playerId) ?? `P${playerId}`,
        }));

        const session = new GameSession({
            room,
            world,
            matchId: snapshot.matchId,
            roster,
            violationSink: this.#options.violationSink,
            meta: {
                serverId: this.#options.serverId,
                buildId: this.#options.buildId,
                mapId: snapshot.mapId,
                mapBundleHash: this.#options.bundle.mapBundleHash,
            },
            onFinished: (finished, result) => {
                this.#sessions.delete(finished.id);
                this.#options.scheduler.remove(finished.id);
                this.#options.onMatchFinished?.(finished, result);
            },
        });

        this.#sessions.set(snapshot.roomId, session);
        this.#options.scheduler.add(session);

        return { startTick: 0, taggerId: tagger.playerId };
    }

    public connectionChanged(roomId: string, playerId: number, connected: boolean): void {
        const session = this.#sessions.get(roomId);
        const player = session?.world.players.find((p) => p.playerId === playerId);
        if (player === undefined) return;
        player.connected = connected;
        // 재접속한 사람은 화면을 처음부터 다시 구성해야 하므로 다음 프레임을 full로 받는다.
        if (connected) session?.requestFullSnapshot(playerId);
    }

    /** 유예가 끝났다. 경기 중이면 탈락이다. 자리를 비워두면 경기가 안 끝난다. */
    public participantTimedOut(roomId: string, playerId: number): void {
        this.#markDead(roomId, playerId);
    }

    public participantRemoved(roomId: string, playerId: number, _reason: string): void {
        this.#markDead(roomId, playerId);
    }

    public queueSkill(roomId: string, request: SkillRequest): boolean {
        const session = this.#sessions.get(roomId);
        if (session === undefined) return false;
        session.queueSkill(request);
        return true;
    }

    public requestFullSnapshot(roomId: string, playerId: number): void {
        this.#sessions.get(roomId)?.requestFullSnapshot(playerId);
    }

    public stopRoom(roomId: string): void {
        const session = this.#sessions.get(roomId);
        if (session === undefined) return;
        session.stop();
        this.#sessions.delete(roomId);
        this.#options.scheduler.remove(roomId);
    }

    #markDead(roomId: string, playerId: number): void {
        const session = this.#sessions.get(roomId);
        const player = session?.world.players.find((p) => p.playerId === playerId);
        if (player === undefined || !player.alive) return;
        player.alive = false;
        player.connected = false;
    }

    /**
     * 시작 위치를 배정한다. MapBuilder가 인원수별로 미리 계산해 둔 좌표를 쓴다.
     *
     * 좌표는 타일 인덱스라 중심으로 옮긴다. 레거시도 `* 1000 + 500`으로 타일 중심에 뒀다.
     * 배정 순서는 `playerId` 오름차순으로 고정한다. 무작위로 섞으면 리플레이가 재현되지 않는다.
     */
    #placePlayers(snapshot: RoomStartSnapshot, tileSize: number, cols: number): PlayerState[] {
        const map = this.#options.bundle.maps[snapshot.mapId];
        const ids = [...snapshot.playerIds].sort((a, b) => a - b);
        const starts = map?.startPositions[ids.length] ?? [];

        return ids.map((playerId, index) => {
            const point = starts[index];
            // 인원수에 맞는 시작 위치가 없으면 맵 중앙 근처에 둔다. 겹치면 첫 tick 밀어내기가 푼다.
            const tileX = point?.[0] ?? Math.floor(cols / 2);
            const tileY = point?.[1] ?? Math.floor(cols / 2);
            return {
                playerId,
                x: (tileX + 0.5) * tileSize,
                y: (tileY + 0.5) * tileSize,
                vx: 0,
                vy: 0,
                facingX: 0,
                facingY: 1,
                radius: GAMEPLAY.PLAYER_RADIUS_PX,
                sightRange: GAMEPLAY.SIGHT_RANGE_PX,
                colorIndex: playerId,
                alive: true,
                isTagger: false,
                connected: true,
                effects: {},
                cooldowns: {},
                loadout: SkillId.Dash,
                stats: emptyStats(),
            } satisfies PlayerState;
        });
    }
}
