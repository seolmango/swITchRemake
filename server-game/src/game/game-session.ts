/**
 * 한 경기의 조립점. 방(rooms)과 시뮬레이션(simulation)을 잇는다.
 *
 * 양쪽 다 상대를 모른다. 방은 소켓과 로비 규칙만 알고, 시뮬레이션은 소켓도 방도 모른다.
 * 그 사이에서 입력을 모아 tick을 돌리고, 나온 권위 프레임을 연결별 뷰로 나눠 보내는 것이
 * 이 파일의 일이다.
 */

import {
    canSeePlayer,
    RoomMode,
    MATCH_RESULT_VERSION,
    PROTOCOL_VERSION,
    VISIBILITY_CORE_VERSION,
    ViolationKind,
    type MatchParticipantResult,
    type MatchResultMessage,
    type ReplayHandleInfo,
    type ViolationSignal,
} from 'shared';
import { GAMEPLAY, RULES_VERSION } from '../config/gameplay';
import { NETWORK } from '../config/network';
import { NullReplayRecorder, type ReplayMeta, type ReplayRecorder } from '../replay/recorder';
import type { Room } from '../rooms/room';
import type { SchedulerTarget } from '../simulation/scheduler';
import { isFinished, stepWorld, type EmojiRequest } from '../simulation/step';
import type { SkillRequest } from '../simulation/skills';
import { toVisibilityWorld, type AuthoritativeFrame, type World, type WorldEvent } from '../simulation/world';
import type { TrainingGround } from '../training/training-ground';
import { SessionReplayRecorder } from './session-recorder';
import { encodeForViewer, type RosterEntry, type SnapshotTileChange } from './snapshot-view';

export interface GameSessionOptions {
    readonly room: Room;
    readonly world: World;
    readonly matchId: string;
    /**
     * 훈련장은 생존자 수로 끝나지 않는다. 혼자 들어가면 생존자가 1명이라 첫 tick에 `isFinished`가
     * 참이 되어 시작하자마자 끝난다. 결과도 내보내지 않는다 — 봇을 잡은 기록이 전적에 남으면 안 된다.
     */
    readonly mode: RoomMode;
    readonly roster: readonly RosterEntry[];
    readonly trainingGround?: TrainingGround;
    readonly violationSink: (signal: ViolationSignal) => void;
    readonly onFinished: (session: GameSession, result: MatchResultMessage) => void;
    /** 경기 시작 시 고정하는 최대 tick. 테스트와 복구 snapshot은 명시할 수 있고, 기본은 밸런스 값이다. */
    readonly maxDurationTicks?: number;
    /** 기록을 켜지 않은 호출자(테스트 등)는 생략할 수 있다. 기본은 아무것도 안 하는 레코더다. */
    readonly recorder?: ReplayRecorder;
    /** 경기 결과에 박히는 값들. 나중에 채울 수 없으므로 시작할 때 받아 둔다. */
    readonly meta: {
        readonly serverId: string;
        readonly buildId: string;
        readonly mapId: string;
        readonly mapBundleHash: string;
    };
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
    /** 이번 tick에 처리할 이모지 요청. 플레이어별 마지막 요청만 보존한다. */
    readonly #pendingEmojis = new Map<number, EmojiRequest>();
    /**
     * full 스냅샷을 아직 못 받은 플레이어. 첫 프레임과 재접속 직후가 여기 들어간다.
     * 연결 id가 아니라 playerId로 잡는 이유는 재접속하면 연결 id가 바뀌기 때문이다.
     */
    readonly #needsFullSnapshot = new Set<number>();
    /** simulation의 이번-tick 신호를 네트워크 publish 경계까지 보존한다. */
    #pendingTileChanges: SnapshotTileChange[] = [];
    readonly #replay: SessionReplayRecorder;
    readonly #maxDurationTicks: number;
    /**
     * 경기 시작 시점의 신원. 경기 중 나간 사람은 room의 roster에서 사라지므로, 결과를 만들 때 roster를
     * 다시 읽으면 그 사람만 `P3` 같은 자리표시자 이름에 userId=null이 된다. 매칭 서버는 결과의 참가자가
     * 배정과 다르면 **경기 전체**를 버리므로, 한 명이 중간에 나가면 나머지 전원의 전적과 결과 화면까지
     * 같이 사라졌다. 그래서 시작할 때 고정한다.
     */
    readonly #identities: ReadonlyMap<number, ReturnType<Room['participants']>[number]>;
    #finished = false;
    readonly #startedAt = Date.now();

    public constructor(options: GameSessionOptions) {
        this.#options = options;
        this.#room = options.room;
        this.world = options.world;
        this.matchId = options.matchId;
        this.#roster = options.roster;
        this.id = options.room.id;

        const maxDurationTicks = options.maxDurationTicks ?? GAMEPLAY.MAX_MATCH_DURATION_TICKS;
        if (!Number.isSafeInteger(maxDurationTicks) || maxDurationTicks < 1) {
            throw new RangeError(`maxDurationTicks must be a positive safe integer: ${maxDurationTicks}`);
        }
        this.#maxDurationTicks = maxDurationTicks;

        this.#identities = new Map(options.room.participants().map((p) => [p.playerId, p]));

        this.#replay = new SessionReplayRecorder({
            recorder: options.recorder ?? new NullReplayRecorder(),
            roster: options.roster,
        });
        this.#replay.begin(this.#buildReplayMeta());
    }

    /** 게스트도 포함해 전원의 당시 신원을 고정한다. 나중에 채울 수 없는 값이다. */
    #buildReplayMeta(): ReplayMeta {
        const identities = this.#identities;
        return {
            matchId: this.matchId,
            mapId: this.#options.meta.mapId,
            snapshotHz: NETWORK.SNAPSHOT_HZ,
            startTick: 0,
            buildId: this.#options.meta.buildId,
            protocolVersion: PROTOCOL_VERSION,
            rulesVersion: RULES_VERSION,
            mapBundleHash: this.#options.meta.mapBundleHash,
            visibilityCoreVersion: VISIBILITY_CORE_VERSION,
            participants: this.world.players.map((player) => {
                const identity = identities.get(player.playerId);
                return {
                    playerId: player.playerId,
                    nickname: identity?.nickname ?? `P${player.playerId}`,
                    colorIndex: player.colorIndex,
                    guest: identity?.guest ?? true,
                };
            }),
        };
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
                userId: this.#actorOf(request.playerId),
                roomId: this.id,
                tick: this.world.tick,
                severity: 'low',
                ruleVersion: 1,
                detail: { kind: 'skill-queue', playerId: request.playerId },
            });
            return;
        }
        this.#pendingSkills.push(request);
    }

    /** 이모지 요청도 tick 경계에서 결정론적으로 적용한다. */
    public queueEmoji(request: EmojiRequest): void {
        if (this.#finished) return;
        if (!this.#pendingEmojis.has(request.playerId) && this.#pendingEmojis.size >= NETWORK.MAX_JSON_COMMANDS_PER_SEC) {
            this.#options.violationSink({
                kind: 'RATE_LIMIT',
                userId: this.#actorOf(request.playerId),
                roomId: this.id,
                tick: this.world.tick,
                severity: 'low',
                ruleVersion: 1,
                detail: { kind: 'emoji-queue', playerId: request.playerId },
            });
            return;
        }
        this.#pendingEmojis.set(request.playerId, request);
    }

    /**
     * 방 범위 `playerId`를 계정/게스트 식별자로 옮긴다.
     *
     * `ViolationSignal.userId`에 playerId를 그대로 넣으면 안 된다. playerId는 1..8이고 방마다
     * 다시 매겨지므로, 제재 소비자가 붙는 날 **엉뚱한 계정**(id 1..8)이 제재된다. 지금은 로그뿐이라
     * 눈에 띄지 않는 종류의 버그다.
     *
     * 훈련 표적처럼 명단에 없는 world 액터는 계정이 없다. 그때는 방 id로 남긴다 — 신호를
     * 버리면 표적을 흉내 낸 요청 폭주가 아무 기록도 남기지 않는다.
     */
    #actorOf(playerId: number): ViolationSignal['userId'] {
        return this.#identities.get(playerId)?.userId ?? `room:${this.id}#${playerId}`;
    }

    /** 훈련장에서 죽은 사람을 되살린다. 경기 방이면 아무것도 하지 않는다. */
    public respawn(playerId: number): boolean {
        return this.#options.trainingGround?.respawn(this.world, playerId) ?? false;
    }

    /** 재접속하거나 관전을 켠 연결에 다음 프레임을 full로 보낸다. */
    public requestFullSnapshot(playerId: number): void {
        this.#needsFullSnapshot.add(playerId);
    }

    /**
     * 연결 종료처럼 tick 사이에서 확정된 탈락을 즉시 반영한다.
     *
     * 생존자가 종료 인원에 닿았다면 다음 tick의 이동ㆍ충돌까지 진행하지 않고 현재 tick에서 정상
     * 종료 경로를 탄다. 그래야 연결 종료 직후의 승자ㆍ결과ㆍ리플레이가 서로 같은 끝 상태를 본다.
     */
    public eliminateDisconnected(playerId: number): boolean {
        if (this.#finished) return false;
        const player = this.world.players.find((candidate) => candidate.playerId === playerId);
        if (player === undefined || !player.alive) return false;

        player.connected = false;
        player.alive = false;
        player.stats.eliminatedAtTick = this.world.tick;
        const events: WorldEvent[] = [{ kind: 'eliminated', playerId }];
        this.#replay.recordEvents(this.world.tick, events);

        if (this.#options.mode === RoomMode.Match && this.#matchHasEnded()) {
            this.#finished = true;
            const frame: AuthoritativeFrame = {
                tick: this.world.tick,
                world: this.world,
                events,
                skillRejections: [],
            };
            this.#replay.recordFinalFrame(frame, this.#pendingTileChanges);
            this.#pendingTileChanges = [];
            this.#startFinish();
        }
        return true;
    }

    public step(): AuthoritativeFrame | null {
        if (this.#finished) return null;

        const inputs = [
            ...this.#room.resolvedInputs(),
            ...(this.#options.trainingGround?.resolveInputs(this.world) ?? []),
        ];
        const skills = [
            ...this.#pendingSkills.splice(0, this.#pendingSkills.length),
            // 표적의 스킬. 사람 요청과 같은 목록에 들어가야 처리 순서(playerId 오름차순)가 하나다.
            ...(this.#options.trainingGround?.resolveSkills(this.world) ?? []),
        ];
        const emojis = [...this.#pendingEmojis.values()];
        this.#pendingEmojis.clear();
        const frame = stepWorld(this.world, inputs, skills, emojis);
        this.#pendingTileChanges.push(...frame.world.tileChanges);

        for (const rejection of frame.skillRejections) {
            this.#room.sendSkillRejected(rejection.playerId, rejection.slot, rejection.reason);
        }
        this.#applyEvents(frame.events);
        this.#options.trainingGround?.afterStep(this.world);
        this.#replay.recordEvents(frame.tick, frame.events);

        if (this.#options.mode === RoomMode.Match && this.#matchHasEnded()) {
            this.#finished = true;
            // 스냅샷 주기와 안 맞아도 마지막 tick은 항상 keyframe으로 남긴다.
            this.#replay.recordFinalFrame(frame);
            this.#startFinish();
            // 마지막 프레임은 보낸다. 탈락 순간이 화면에 안 나오면 갑자기 결과창이 뜬다.
            return frame;
        }
        return frame;
    }

    public publish(frame: AuthoritativeFrame): void {
        const tileChanges = this.#pendingTileChanges;
        try {
            for (const target of this.#room.snapshotTargets()) {
                if (target.access === 'none') continue;

                const full = this.#needsFullSnapshot.delete(target.playerId) || frame.tick <= 1;
                const payload = encodeForViewer(frame, {
                    playerId: target.access === 'unfiltered' ? null : target.playerId,
                    access: target.access,
                    full,
                }, this.#roster, tileChanges);

                // backpressure: 밀린 연결에는 교체 가능한 위치 스냅샷을 건너뛴다. 타일 변경처럼 누적돼야
                // 하는 것은 full 스냅샷으로 따라잡게 만든다.
                if (!full && target.connection.bufferedBytes() > NETWORK.SOCKET_BUFFER_SOFT_LIMIT_BYTES) {
                    this.#needsFullSnapshot.add(target.playerId);
                    continue;
                }
                target.connection.sendBinary(payload);
            }

            // #finish()가 이미 이번 tick의 마지막 프레임을 기록했다. 여기서 다시 쓰면 중복이다.
            if (!this.#finished) this.#replay.recordSnapshotTick(frame, tileChanges);
        } finally {
            // full 뷰어와 delta 뷰어, 리플레이가 모두 같은 누적분을 소비한 뒤에만 비운다.
            this.#pendingTileChanges = [];
        }
    }

    public stop(): void {
        if (this.#finished) return;
        this.#finished = true;
        this.#replay.abort('session-stopped');
    }

    /**
     * 종료 시간은 step이 확정한 권위 tick으로만 잰다. 최대 tick에 도달한 프레임의 탈락 판정까지
     * 모두 반영된 뒤 생존자를 고르므로, 그 시점에 살아 있는 술래를 포함한 전원이 승자다.
     */
    #matchHasEnded(): boolean {
        return isFinished(this.world) || this.world.tick >= this.#maxDurationTicks;
    }

    /**
     * 시뮬레이션이 만든 사실을 방에 알린다.
     *
     * 판정은 이미 끝났고 여기서는 전달만 한다. 방이 탈락을 다시 판정하거나 시뮬레이션이 로비
     * 메시지를 직접 보내기 시작하면 두 계층이 섞인다.
     */
    #applyEvents(events: readonly WorldEvent[]): void {
        // 좌표를 싣는 연출이 있을 때만 만든다. 대부분의 tick에는 그런 사건이 없다.
        let visibility: ReturnType<typeof toVisibilityWorld> | null = null;
        const canSee = (playerId: number): ((viewerPlayerId: number) => boolean) => {
            visibility ??= toVisibilityWorld(this.world);
            return (viewerPlayerId) => canSeePlayer(visibility!, viewerPlayerId, playerId);
        };

        for (const event of events) {
            switch (event.kind) {
                case 'eliminated':
                    // 더미는 world 액터일 뿐 로비 참가자가 아니므로 강퇴ㆍ관전 전환 흐름에 넘기지 않는다.
                    if (!this.#options.trainingGround?.isDummy(event.playerId)) {
                        this.#room.markEliminated(event.playerId, event.by ?? event.playerId);
                    }
                    break;
                case 'tagged':
                    this.#room.broadcastTagged(event.playerId, event.by ?? null);
                    break;
                case 'blinked':
                    this.#room.broadcastBlinked(event.playerId, event.fromX ?? 0, event.fromY ?? 0, canSee(event.playerId));
                    break;
                case 'skillArea':
                    this.#room.broadcastSkillArea(
                        event.skillId ?? '', event.playerId,
                        event.fromX ?? 0, event.fromY ?? 0, event.targetPlayerId ?? null,
                        canSee(event.playerId),
                    );
                    break;
                case 'skillUsed':
                    break;
            }
        }
    }

    /**
     * 비동기인 이유는 리플레이 저장 하나다. 로컬 파일 쓰기 정도라 게임 루프를 막을 만큼 오래
     * 걸리지 않고, 이 경기는 이미 끝났으므로 다른 방의 tick도 막지 않는다. Redis로 나가는
     * 결과 전송(outbox)은 여기서 기다리지 않는다 — 그건 네트워크 왕복이라 다른 문제다.
     */
    #startFinish(): void {
        void this.#finish().catch((error: unknown) => this.#handleFinishException(error));
    }

    /** 종료 불변식 하나가 무너져도 이 방만 정리하고 다른 방의 게임 루프에는 전파하지 않는다. */
    #handleFinishException(error: unknown): void {
        try {
            this.#options.violationSink({
                kind: ViolationKind.BadState,
                userId: `room:${this.id}`,
                roomId: this.id,
                tick: this.world.tick,
                severity: 'high',
                ruleVersion: 1,
                detail: {
                    kind: 'internal-exception',
                    phase: 'finish',
                    matchId: this.matchId,
                    error: error instanceof Error ? error.name : typeof error,
                },
            });
        } catch (signalError: unknown) {
            // 진단 소비자의 장애가 원래 예외 경계를 다시 뚫으면 안 된다.
            console.error('[swITch] game-session violation sink failed', signalError);
        }

        try {
            this.#replay.abort('session-finish-failed');
        } catch (abortError: unknown) {
            console.error('[swITch] failed to abort replay after game-session failure', abortError);
        }

        try {
            // 결과를 확정할 수 없는 방을 Playing에 남기지 않는다. close가 lifecycle의 세션과
            // scheduler 등록을 함께 회수하고, 이 방의 연결만 정상 종료한다.
            this.#room.close();
        } catch (closeError: unknown) {
            console.error('[swITch] failed to close room after game-session failure', closeError);
        }
    }

    async #finish(): Promise<void> {
        const winners = this.#confirmedWinnerIds();
        if (!this.#room.finishGame(winners)) {
            // 방이 이미 POST_GAME/Closed라면 이 세션은 더 이상 그 방의 결과 권한을 갖지 않는다.
            // 비동기 종료가 늦게 돌아온 경우에도 두 번째 결과를 만들지 않고 기록을 버린다.
            this.#replay.abort('room-already-finished');
            return;
        }
        const replay = await this.#replay.finish({ endTick: this.world.tick });
        this.#options.onFinished(this, this.#buildResult(winners, replay));
    }

    /**
     * shared 결과 계약을 서버가 확정하는 지점이다. 권위 world의 실제 경기 참가자 중 생존자만
     * 고르고, 중복을 제거한 뒤 playerId 오름차순으로 고정한다. 따라서 반환값은 비어 있지 않고,
     * 중복이 없으며, 결과 `players`에도 들어가는 slot만 담는다.
     */
    #confirmedWinnerIds(): readonly number[] {
        const winners = [...new Set(this.world.players
            .filter((player) => player.alive && this.#identities.has(player.playerId))
            .map((player) => player.playerId))]
            .sort((a, b) => a - b);
        if (winners.length === 0) {
            throw new Error(`match ${this.matchId} finished without a surviving participant`);
        }
        return Object.freeze(winners);
    }

    /**
     * 경기 결과 메시지. 버전 스탬프와 당시 닉네임은 **나중에 채울 수 없는 값**이라 여기서 전부 넣는다.
     * 컬럼을 나중에 추가할 수는 있어도 추가 이전 경기의 값은 영원히 빈다.
     */
    #buildResult(winners: readonly number[], replay: ReplayHandleInfo | null): MatchResultMessage {
        const endedAt = Date.now();
        const msPerTick = 1000 / this.world.simulationHz;
        const identities = this.#identities;

        // world에는 로스터 밖 연습 액터가 있을 수 있어도 결과ㆍ전적의 행은 실제 참가자에게만 만든다.
        const players: MatchParticipantResult[] = this.world.players
            .filter((player) => identities.has(player.playerId))
            .map((player) => {
                const identity = identities.get(player.playerId);
                const endTick = player.stats.eliminatedAtTick ?? this.world.tick;
                const guest = identity?.guest ?? true;
                return {
                    // 게스트는 null이지만 행 자체는 남긴다. 리플레이가 전원의 slot과 이름을 필요로 한다.
                    userId: guest || typeof identity?.userId !== 'number' ? null : identity.userId,
                    playerId: player.playerId,
                    nickname: identity?.nickname ?? `P${player.playerId}`,
                    colorIndex: player.colorIndex,
                    isGuest: guest,
                    tagCount: player.stats.tagCount,
                    taggedCount: player.stats.taggedCount,
                    switchTry: player.stats.switchTry,
                    switchSuccess: player.stats.switchSuccess,
                    survivedMs: Math.round(endTick * msPerTick),
                };
            });

        return {
            v: MATCH_RESULT_VERSION,
            matchId: this.matchId,
            roomId: this.id,
            serverId: this.#options.meta.serverId,
            mapId: this.#options.meta.mapId,
            startedAt: this.#startedAt,
            endedAt,
            durationTicks: this.world.tick,
            buildId: this.#options.meta.buildId,
            protocolVersion: PROTOCOL_VERSION,
            rulesVersion: RULES_VERSION,
            mapBundleHash: this.#options.meta.mapBundleHash,
            visibilityCoreVersion: VISIBILITY_CORE_VERSION,
            winnerPlayerIds: winners,
            // 기록 실패(abort)와 리플레이 꺼짐이 같은 null인 것은 의도적이다. 원인은 로그에만 남는다.
            replay,
            players,
        };
    }
}
