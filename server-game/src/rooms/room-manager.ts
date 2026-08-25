import {
    ControlErrorCode,
    decodeInput,
    ErrorCode,
    isLoadoutSkill,
    PlayerRole,
    RoomState,
    RoomMode,
    ViolationKind,
    type ActorId,
    type ClientMessage,
    type ControlErrorCode as ControlErrorCodeValue,
    type ViolationSignal,
} from 'shared';
import { GAMEPLAY, RULES_VERSION, hudGameplayPayload } from '../config/gameplay';
import { NETWORK } from '../config/network';
import type { RoomAdmissionPort } from '../gateway/ticket-auth';
import type { SeatReservation } from '../gateway/ticket-store';
import type { Connection, TransportHandlers } from '../transport/game-transport';
import {
    Room,
    type RoomLifecyclePort,
    type RoomOptions,
    type RoomProjection,
    type RoomTiming,
    type SnapshotAccess,
} from './room';

export interface CreateManagedRoom {
    readonly id: string;
    readonly roomCode: string;
    readonly matchId: string;
    readonly name: string;
    readonly password: string | null;
    readonly capacity: number;
    readonly mapId: string;
    readonly ownerReservation: Readonly<SeatReservation>;
    readonly mode?: RoomMode;
}

export type ManagerResult<T> =
    | { ok: true; value: T }
    | { ok: false; code: ControlErrorCodeValue };

export interface RoomManagerOptions {
    readonly lifecycle: RoomLifecyclePort;
    readonly isKnownMap: (mapId: string) => boolean;
    readonly getServerTick: () => number;
    readonly violationSink: (signal: ViolationSignal) => void;
    /** resume 인증 직후 full snapshot을 보낼 외부 publisher 경계. */
    readonly onResume?: (connection: Connection, access: SnapshotAccess) => void;
    /** game.useSkill을 시뮬레이션으로 넘기는 경계. 성공 여부는 tick 경계에서 정해진다. */
    readonly skillSink?: (roomId: string, request: { playerId: number; slot: number; targetPlayerId?: number }) => boolean;
    readonly emojiSink?: (roomId: string, request: { playerId: number; emojiId: number }) => boolean;
    readonly now?: () => number;
    readonly timing?: Partial<RoomTiming>;
    readonly maxRooms?: number;
    /** Single integration point for room-directory-visible changes. */
    readonly onDirectoryChanged?: () => void;
}

const DEFAULT_TIMING: RoomTiming = Object.freeze({
    countdownMs: NETWORK.COUNTDOWN_MS,
    postGameMs: NETWORK.POST_GAME_MS,
    reconnectGraceMs: NETWORK.RECONNECT_GRACE_MS,
    startLockOnJoinMs: NETWORK.START_LOCK_ON_JOIN_MS,
    startLockOnMapChangeMs: NETWORK.START_LOCK_ON_MAP_CHANGE_MS,
    startLockJoinBudgetMs: NETWORK.START_LOCK_JOIN_BUDGET_MS,
    startLockJoinBudgetWindowMs: NETWORK.START_LOCK_JOIN_BUDGET_WINDOW_MS,
});

function gameplayRules(): Readonly<Record<string, number | string | boolean>> {
    return Object.freeze({ rulesVersion: RULES_VERSION, ...GAMEPLAY });
}

/**
 * GameTransport/티켓 인증과 Room 사이의 조립 경계.
 * Redis 명령 소비자는 이 클래스의 create/reserve/release/kick 메서드만 호출하면 된다.
 */
export class RoomManager implements RoomAdmissionPort, TransportHandlers {
    readonly #rooms = new Map<string, Room>();
    readonly #options: RoomManagerOptions;
    readonly #now: () => number;
    readonly #timing: RoomTiming;

    public constructor(options: RoomManagerOptions) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
        this.#timing = Object.freeze({ ...DEFAULT_TIMING, ...options.timing });
    }

    public get size(): number {
        return this.#rooms.size;
    }

    public get(roomId: string): Room | null {
        return this.#rooms.get(roomId) ?? null;
    }

    public projections(): RoomProjection[] {
        return [...this.#rooms.values()].map((room) => room.projection());
    }

    public createRoom(specification: CreateManagedRoom): ManagerResult<Room> {
        this.sweep();
        if (this.#rooms.has(specification.id)) return { ok: false, code: ControlErrorCode.Internal };
        if ((this.#options.maxRooms ?? Number.POSITIVE_INFINITY) <= this.#rooms.size) {
            return { ok: false, code: ControlErrorCode.ServerFull };
        }
        if (!this.#options.isKnownMap(specification.mapId)) return { ok: false, code: ControlErrorCode.InvalidMap };
        if (specification.ownerReservation.expiresAt <= this.#now()) return { ok: false, code: ControlErrorCode.Expired };

        let room: Room;
        try {
            const options: RoomOptions = {
                id: specification.id,
                roomCode: specification.roomCode,
                matchId: specification.matchId,
                name: specification.name,
                password: specification.password,
                capacity: specification.capacity,
                mapId: specification.mapId,
                ownerReservation: specification.ownerReservation,
                mode: specification.mode ?? RoomMode.Match,
                // 훈련장은 혼자 시작한다. 사람을 셋 모아야 연습할 수 있으면 연습장이 아니다.
                minPlayersToStart: specification.mode === RoomMode.Training ? 1 : GAMEPLAY.MIN_PLAYERS_TO_START,
                simulationHz: NETWORK.SIMULATION_HZ,
                rules: gameplayRules(),
                hudGameplay: hudGameplayPayload(),
                timing: this.#timing,
                lifecycle: this.#options.lifecycle,
                isKnownMap: this.#options.isKnownMap,
                getServerTick: this.#options.getServerTick,
                ...(this.#options.onDirectoryChanged === undefined
                    ? {}
                    : { onDirectoryChanged: this.#options.onDirectoryChanged }),
                now: this.#now,
            };
            room = new Room(options);
        } catch {
            return { ok: false, code: ControlErrorCode.Internal };
        }
        this.#rooms.set(room.id, room);
        this.#options.onDirectoryChanged?.();
        return { ok: true, value: room };
    }

    public reserveJoin(reservation: Readonly<SeatReservation>, password: string | null): ManagerResult<{ playerId: number }> {
        const room = this.#rooms.get(reservation.roomId);
        if (room === undefined) return { ok: false, code: ControlErrorCode.RoomNotFound };
        const error = room.reserveJoin(reservation, password);
        if (error !== null) return { ok: false, code: error };
        const playerId = room.memberByUser(reservation.userId)?.playerId
            ?? this.#heldPlayerId(room, reservation.userId);
        if (playerId === null) return { ok: false, code: ControlErrorCode.Internal };
        return { ok: true, value: { playerId } };
    }

    public reserveResume(reservation: Readonly<SeatReservation>): ManagerResult<{ playerId: number }> {
        const room = this.#rooms.get(reservation.roomId);
        if (room === undefined) return { ok: false, code: ControlErrorCode.RoomNotFound };
        if (!reservation.resume || reservation.expiresAt <= this.#now()) return { ok: false, code: ControlErrorCode.Expired };
        const error = room.canReserveResume(reservation.userId);
        if (error !== null) return { ok: false, code: error };
        const member = room.memberByUser(reservation.userId);
        if (member === null) return { ok: false, code: ControlErrorCode.NoGraceSlot };
        return { ok: true, value: { playerId: member.playerId } };
    }

    public releaseSeat(roomId: string, userId: ActorId): ManagerResult<Record<string, never>> {
        const room = this.#rooms.get(roomId);
        if (room === undefined) return { ok: false, code: ControlErrorCode.RoomNotFound };
        room.releaseSeat(userId);
        if (room.state === RoomState.Closed) this.#rooms.delete(roomId);
        return { ok: true, value: {} };
    }

    public kickUser(roomId: string, userId: ActorId, reason: string): ManagerResult<Record<string, never>> {
        const room = this.#rooms.get(roomId);
        if (room === undefined) return { ok: false, code: ControlErrorCode.RoomNotFound };
        room.forceKick(userId, reason);
        if (room.state === RoomState.Closed) this.#rooms.delete(roomId);
        return { ok: true, value: {} };
    }

    public admitReservation(reservation: Readonly<SeatReservation>) {
        const room = this.#rooms.get(reservation.roomId);
        return room?.admitReservation(reservation) ?? null;
    }

    public onConnect(connection: Connection): void {
        const room = this.#rooms.get(connection.roomId);
        if (room === undefined || !room.bindConnection(connection)) throw new Error('connection has no claimed room seat');
        if (connection.resume && this.#options.onResume !== undefined) {
            queueMicrotask(() => {
                const current = this.#rooms.get(connection.roomId);
                if (current?.memberByUser(connection.userId)?.connection?.id === connection.id) {
                    this.#options.onResume?.(connection, current.snapshotAccess(connection.userId));
                }
            });
        }
    }

    public onInput(connection: Connection, frame: ArrayBuffer): void {
        const room = this.#rooms.get(connection.roomId);
        if (room === undefined) return;
        let input;
        try {
            input = decodeInput(frame);
        } catch {
            this.#signal(connection, room, ViolationKind.BadLength, 'medium');
            return;
        }
        const member = room.memberByUser(connection.userId);
        if (room.state !== RoomState.Playing || member === null || member.role !== PlayerRole.Player
            || member.spectatorEligible) {
            this.#signal(connection, room, member?.role === PlayerRole.Spectator
                ? ViolationKind.SpectatorInput
                : ViolationKind.BadState, 'medium');
            return;
        }
        room.acceptInput(connection, input);
    }

    public onJson(connection: Connection, message: ClientMessage): void {
        const room = this.#rooms.get(connection.roomId);
        if (room === undefined) {
            connection.sendJson({
                type: 'error',
                payload: { requestId: message.requestId ?? null, code: ErrorCode.RoomClosed, retryable: false },
            });
            return;
        }
        const requestId = message.requestId ?? null;
        let error: typeof ErrorCode[keyof typeof ErrorCode] | null = null;
        switch (message.type) {
            case 'lobby.setMap':
                error = room.setMap(connection.userId, message.payload.mapId);
                break;
            case 'lobby.kick':
                error = room.kick(connection.userId, message.payload.playerId);
                break;
            case 'lobby.passHost':
                error = room.passHost(connection.userId, message.payload.playerId);
                break;
            case 'lobby.setLocked':
                error = room.setLocked(connection.userId, message.payload.locked);
                break;
            case 'lobby.setSlot': {
                const result = room.moveSlot(connection.userId, message.payload.slot);
                if (result === 'bad-state' || result === 'occupied') error = ErrorCode.BadState;
                else if (result === 'not-found' || result === 'out-of-range') error = ErrorCode.InvalidPayload;
                break;
            }
            case 'lobby.start':
                error = room.requestStart(connection.userId);
                break;
            case 'lobby.leave':
                if (room.state !== RoomState.Waiting && room.state !== RoomState.PostGame) error = ErrorCode.BadState;
                else {
                    room.releaseSeat(connection.userId, 'left');
                    connection.close(1000, 'left');
                    if (room.playerCount === 0) this.#rooms.delete(room.id);
                }
                break;
            case 'lobby.spectate':
                error = room.setSpectating(connection.userId, message.payload.spectate);
                break;
            case 'lobby.setLoadout':
                // 상태 판정은 Room이 한다(경기 후 30초 동안도 로비에서 바꿀 수 있어야 한다).
                // 여기서는 payload 모양만 본다.
                if (message.payload.skills.length !== 1 || !isLoadoutSkill(message.payload.skills[0]!)) {
                    error = ErrorCode.InvalidPayload;
                    break;
                }
                error = room.setLoadout(connection.userId, message.payload.skills[0]);
                break;
            case 'game.useSkill': {
                const member = room.memberByUser(connection.userId);
                if (member?.role === PlayerRole.Spectator) {
                    this.#signal(connection, room, ViolationKind.SpectatorInput, 'medium', { kind: 'skill' });
                    error = ErrorCode.BadState;
                    break;
                }
                if (room.state !== RoomState.Playing || member === null || !member.inCurrentGame) {
                    error = ErrorCode.BadState;
                    break;
                }
                // 성공 여부(쿨타임, 사거리)는 rooms가 판정하지 않는다. 요청만 넘기고
                // tick 경계에서 시뮬레이션이 정한다. 실제 시각 순서로 판정하면 결정론이 깨진다.
                const queued = this.#options.skillSink?.(room.id, {
                    playerId: member.playerId,
                    slot: message.payload.slot,
                    ...(message.payload.targetPlayerId === undefined
                        ? {}
                        : { targetPlayerId: message.payload.targetPlayerId }),
                });
                if (queued !== true) error = ErrorCode.BadState;
                break;
            }
            case 'game.emoji': {
                const member = room.memberByUser(connection.userId);
                if (room.state !== RoomState.Playing || member === null || !member.inCurrentGame
                    || member.role !== PlayerRole.Player || member.spectatorEligible) {
                    error = ErrorCode.BadState;
                    break;
                }
                // SnapshotPlayer.emojiId is encoded as u8.
                if (message.payload.emojiId < 0 || message.payload.emojiId > 0xff) {
                    error = ErrorCode.InvalidPayload;
                    break;
                }
                const queued = this.#options.emojiSink?.(room.id, {
                    playerId: member.playerId,
                    emojiId: message.payload.emojiId,
                });
                if (queued !== true) error = ErrorCode.BadState;
                break;
            }
            case 'ping':
                connection.sendJson({
                    type: 'pong',
                    payload: {
                        clientTime: message.payload.clientTime,
                        serverTime: this.#now(),
                        serverTick: this.#options.getServerTick(),
                    },
                });
                break;
            case 'auth':
                error = ErrorCode.BadState;
                break;
        }
        if (error !== null) room.sendError(connection, requestId, error);
    }

    public onDisconnect(connection: Connection, reason: string): void {
        const room = this.#rooms.get(connection.roomId);
        if (room === undefined) return;
        room.disconnect(connection, reason);
    }

    /** 타이머/Redis heartbeat 루프에서 호출해 TTL과 자동 전이를 진행한다. */
    public sweep(now: number = this.#now()): string[] {
        const closed: string[] = [];
        for (const [roomId, room] of this.#rooms) {
            room.advance(now);
            if (room.state === RoomState.Closed) {
                this.#rooms.delete(roomId);
                closed.push(roomId);
            }
        }
        return closed;
    }

    public counts(): { waiting: number; playing: number } {
        let waiting = 0;
        let playing = 0;
        for (const room of this.#rooms.values()) {
            if (room.state === RoomState.Waiting) waiting += 1;
            if (room.state === RoomState.Countdown || room.state === RoomState.Playing || room.state === RoomState.PostGame) playing += 1;
        }
        return { waiting, playing };
    }

    #heldPlayerId(room: Room, userId: ActorId): number | null {
        return room.reservedPlayerId(userId);
    }

    #signal(
        connection: Connection,
        room: Room,
        kind: typeof ViolationKind[keyof typeof ViolationKind],
        severity: 'low' | 'medium' | 'high',
        detail?: Record<string, number | string>,
    ): void {
        this.#options.violationSink({
            kind,
            userId: connection.userId,
            roomId: room.id,
            tick: this.#options.getServerTick(),
            severity,
            ruleVersion: 1,
            ...(detail === undefined ? {} : { detail }),
        });
    }
}
