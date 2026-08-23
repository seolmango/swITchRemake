/**
 * 한 경기의 조립점. 방(rooms)과 시뮬레이션(simulation)을 잇는다.
 *
 * 양쪽 다 상대를 모른다. 방은 소켓과 로비 규칙만 알고, 시뮬레이션은 소켓도 방도 모른다.
 * 그 사이에서 입력을 모아 tick을 돌리고, 나온 권위 프레임을 연결별 뷰로 나눠 보내는 것이
 * 이 파일의 일이다.
 */

import type { ViolationSignal } from 'shared';
import { NETWORK } from '../config/network';
import type { Room } from '../rooms/room';
import type { SchedulerTarget } from '../simulation/scheduler';
import { isFinished, stepWorld } from '../simulation/step';
import type { SkillRequest } from '../simulation/skills';
import type { AuthoritativeFrame, World, WorldEvent } from '../simulation/world';
import { encodeForViewer, type RosterEntry } from './snapshot-view';

export interface GameSessionOptions {
    readonly room: Room;
    readonly world: World;
    readonly matchId: string;
    readonly roster: readonly RosterEntry[];
    readonly violationSink: (signal: ViolationSignal) => void;
    readonly onFinished: (session: GameSession) => void;
}

export class GameSession implements SchedulerTarget {
    readonly id: string;
    readonly world: World;
    readonly matchId: string;

    readonly #room: Room;
    readonly #roster: readonly RosterEntry[];
    readonly #options: GameSessionOptions;
    /** 이번 tick에 처리할 스킬 요청. 처리 후 비운다. */
    readonly #pendingSkills: SkillRequest[] = [];
    /**
     * full 스냅샷을 아직 못 받은 플레이어. 첫 프레임과 재접속 직후가 여기 들어간다.
     * 연결 id가 아니라 playerId로 잡는 이유는 재접속하면 연결 id가 바뀌기 때문이다.
     */
    readonly #needsFullSnapshot = new Set<number>();
    #finished = false;

    public constructor(options: GameSessionOptions) {
        this.#options = options;
        this.#room = options.room;
        this.world = options.world;
        this.matchId = options.matchId;
        this.#roster = options.roster;
        this.id = options.room.id;
    }

    /**
     * 스킬 요청을 받아둔다. 판정은 다음 tick에 시뮬레이션이 한다.
     *
     * 여기서 즉시 판정하지 않는 이유는 결정론이다. 요청이 도착한 실제 시각이 아니라 tick 경계에서
     * 정해진 순서로 처리해야 같은 입력이 같은 결과를 낸다.
     */
    public queueSkill(request: SkillRequest): void {
        if (this.#finished) return;
        if (this.#pendingSkills.length >= NETWORK.MAX_JSON_COMMANDS_PER_SEC) {
            this.#options.violationSink({
                kind: 'RATE_LIMIT',
                userId: request.playerId,
                roomId: this.id,
                tick: this.world.tick,
                severity: 'low',
                ruleVersion: 1,
                detail: { kind: 'skill-queue' },
            });
            return;
        }
        this.#pendingSkills.push(request);
    }

    /** 재접속하거나 관전을 켠 연결에 다음 프레임을 full로 보낸다. */
    public requestFullSnapshot(playerId: number): void {
        this.#needsFullSnapshot.add(playerId);
    }

    public step(): AuthoritativeFrame | null {
        if (this.#finished) return null;

        const inputs = this.#room.resolvedInputs();
        const skills = this.#pendingSkills.splice(0, this.#pendingSkills.length);
        const frame = stepWorld(this.world, inputs, skills);

        this.#applyEvents(frame.events);

        if (isFinished(this.world)) {
            this.#finished = true;
            this.#finish();
            // 마지막 프레임은 보낸다. 탈락 순간이 화면에 안 나오면 갑자기 결과창이 뜬다.
            return frame;
        }
        return frame;
    }

    public publish(frame: AuthoritativeFrame): void {
        for (const target of this.#room.snapshotTargets()) {
            if (target.access === 'none') continue;

            const full = this.#needsFullSnapshot.delete(target.playerId) || frame.tick <= 1;
            const payload = encodeForViewer(frame, {
                playerId: target.access === 'unfiltered' ? null : target.playerId,
                access: target.access,
                full,
            }, this.#roster);

            // backpressure: 밀린 연결에는 교체 가능한 위치 스냅샷을 건너뛴다. 타일 변경처럼 누적돼야
            // 하는 것은 full 스냅샷으로 따라잡게 만든다.
            if (!full && target.connection.bufferedBytes() > NETWORK.SOCKET_BUFFER_SOFT_LIMIT_BYTES) {
                this.#needsFullSnapshot.add(target.playerId);
                continue;
            }
            target.connection.sendBinary(payload);
        }
    }

    public stop(): void {
        this.#finished = true;
    }

    /**
     * 시뮬레이션이 만든 사실을 방에 알린다.
     *
     * 판정은 이미 끝났고 여기서는 전달만 한다. 방이 탈락을 다시 판정하거나 시뮬레이션이 로비
     * 메시지를 직접 보내기 시작하면 두 계층이 섞인다.
     */
    #applyEvents(events: readonly WorldEvent[]): void {
        for (const event of events) {
            switch (event.kind) {
                case 'eliminated':
                    this.#room.markEliminated(event.playerId, event.by ?? event.playerId);
                    break;
                case 'tagged':
                    this.#room.broadcastTagged(event.playerId, event.by ?? null);
                    break;
                case 'blinked':
                    this.#room.broadcastBlinked(event.playerId, event.fromX ?? 0, event.fromY ?? 0);
                    break;
                case 'skillUsed':
                    break;
            }
        }
    }

    #finish(): void {
        const survivors = this.world.players
            .filter((player) => player.alive)
            .sort((a, b) => a.playerId - b.playerId)
            .map((player) => player.playerId);

        // 종료 조건은 "생존자 N명 이하"라서 동시 탈락으로 더 적게 남을 수 있다.
        // 자리를 억지로 채우지 않고 남은 만큼만 승자로 본다.
        const winners: [number, number] = [survivors[0] ?? 0, survivors[1] ?? survivors[0] ?? 0];
        this.#room.finishGame(winners);
        this.#options.onFinished(this);
    }
}
