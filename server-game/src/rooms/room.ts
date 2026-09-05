import { createHash, timingSafeEqual } from 'node:crypto';
import {
    CloseCode,
    ControlErrorCode,
    ErrorCode,
    isNewerSequence,
    isRetryable,
    movementVector,
    PlayerRole,
    RoomState,
    RoomMode,
    type ActorId,
    type AdoptRoomPayload,
    type AdoptedRoomMember,
    type ControlErrorCode as ControlErrorCodeValue,
    type ErrorCode as ErrorCodeValue,
    type InputState,
    type LobbyPlayer,
    type PlayerRole as PlayerRoleValue,
    type RoomState as RoomStateValue,
    type ServerMessage,
    type SkillId,
    type SkillRejection,
} from 'shared';
import type { SeatReservation } from '../gateway/ticket-store';
import type { ResolvedInput } from '../simulation/world';
import type { Connection } from '../transport/game-transport';
import { LobbyRoster, StartLock, type LobbyMember, type MoveSlotResult } from './lobby-state';
import { RoomStateMachine } from './room-state';

export interface RoomStartPlayer {
    readonly playerId: number;
    /** Recovery-created snapshots may predate loadout persistence, so consumers keep a default. */
    readonly loadout?: SkillId;
}

export interface RoomStartSnapshot {
    readonly roomId: string;
    readonly matchId: string;
    readonly mapId: string;
    readonly mode: RoomMode;
    readonly players: readonly RoomStartPlayer[];
    readonly rules: Readonly<Record<string, number | string | boolean>>;
}

export interface GameStartInfo {
    readonly startTick: number;
    readonly taggerId: number;
}

/**
 * 방 수명과 시뮬레이션의 좁은 연결점. 연결 종료와 명시적 퇴장이 시뮬레이션의 생존 상태에
 * 미치는 영향은 rooms가 직접 world를 건드리지 않고 조립 계층에 알린다.
 */
export interface RoomLifecyclePort {
    startGame(snapshot: RoomStartSnapshot): GameStartInfo;
    /** 방이 사라졌다. 결과를 내보내지 않고 돌던 세션만 내린다. */
    stopRoom(roomId: string): void;
    connectionChanged(roomId: string, playerId: number, connected: boolean): void;
    /** 경기 중 연결이 끊긴 참가자를 즉시 시뮬레이션에서 탈락시킨다. */
    participantDisconnected(roomId: string, playerId: number): void;
    participantRemoved(roomId: string, playerId: number, reason: string): void;
}

export interface RoomTiming {
    readonly countdownMs: number;
    readonly postGameMs: number;
    readonly reconnectGraceMs: number;
    readonly startLockOnJoinMs: number;
    readonly startLockOnMapChangeMs: number;
    readonly startLockJoinBudgetMs: number;
    readonly startLockJoinBudgetWindowMs: number;
}

export interface RoomOptions {
    readonly id: string;
    readonly roomCode: string;
    readonly matchId: string;
    readonly name: string;
    readonly password: string | null;
    readonly mode: RoomMode;
    readonly capacity: number;
    readonly mapId: string;
    /**
     * 새로 만드는 방의 방장 좌석. 다른 서버에서 넘겨받는 방은 대신 `adopted`가 온다 —
     * 그 사람들은 이미 방에 있었으므로 예약할 자리가 없다.
     */
    readonly ownerReservation?: Readonly<SeatReservation>;
    /** 넘겨받는 방의 명단. `ownerReservation`과 둘 중 하나만 온다. */
    readonly adopted?: readonly AdoptedRoomMember[];
    readonly minPlayersToStart: number;
    /**
     * 지금 새 경기를 시작해도 되는가. 결과 outbox가 가득 차면 false다.
     *
     * 결과를 내보낼 자리가 없는데 경기를 시작하면 끝나는 순간 전적이 조용히 사라진다.
     * 시작을 거절하는 쪽이 낫다 — 사람이 다시 누를 수 있고, outbox는 Redis가 살아나면 비워진다.
     * 생략하면 항상 시작할 수 있다(테스트 기본값).
     */
    readonly canStartGame?: () => boolean;
    readonly simulationHz: number;
    readonly rules: Readonly<Record<string, number | string | boolean>>;
    readonly hudGameplay: Readonly<Record<string, number>>;
    readonly timing: RoomTiming;
    readonly lifecycle: RoomLifecyclePort;
    /**
     * 이 방이 그 맵으로 놀 수 있는가. 방 모드를 같이 받는 이유는 훈련장 맵 때문이다 —
     * 존재하는 맵이지만 경기 방이 고르면 안 된다.
     */
    readonly isKnownMap: (mapId: string, mode: RoomMode) => boolean;
    readonly getServerTick: () => number;
    /** Notifies the directory publisher after a room-list-visible change. */
    readonly onDirectoryChanged?: () => void;
    readonly now?: () => number;
}

export type SnapshotAccess = 'none' | 'filtered' | 'unfiltered';

/** 이 뷰어가 연출의 주인공을 보고 있는가. 시야 판정은 시뮬레이션을 아는 쪽이 한다. */
export type ViewerFilter = (viewerPlayerId: number) => boolean;

export interface Admission {
    readonly playerId: number;
    readonly roomState: RoomStateValue;
    readonly role: PlayerRoleValue;
}

export interface RoomProjection {
    readonly roomId: string;
    readonly roomCode: string;
    readonly matchId: string;
    readonly name: string;
    readonly ownerName: string;
    readonly mapId: string;
    readonly state: RoomStateValue;
    readonly playerCount: number;
    readonly capacity: number;
    readonly hasPassword: boolean;
    readonly locked: boolean;
    readonly mode: RoomMode;
}

function passwordMatches(expected: string, supplied: string): boolean {
    const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
    const suppliedDigest = createHash('sha256').update(supplied, 'utf8').digest();
    return timingSafeEqual(expectedDigest, suppliedDigest);
}

/** 단일 방의 권위 상태. 소켓 구현과 Redis를 직접 알지 않는다. */
export class Room {
    readonly id: string;
    readonly roomCode: string;
    readonly mode: RoomMode;
    readonly name: string;
    readonly #password: string | null;
    readonly #options: RoomOptions;
    readonly #now: () => number;
    readonly #stateMachine: RoomStateMachine;
    readonly #roster: LobbyRoster;
    readonly #startLock: StartLock;
    readonly #kickedUsers = new Set<ActorId>();
    #mapId: string;
    /** 매칭 서버가 방 배정 시 발급한 경기 id. 인게임 서버는 새 값을 만들 권한이 없다. */
    #matchId: string;
    /**
     * 매칭 서버가 `GRANT_MATCH`로 내려준 **다음** 경기 id. 아직 안 왔으면 null이다.
     *
     * 예전에는 두 번째 경기부터 인게임 서버가 `randomUUID()`로 만들었다. 그러면 발급 주체가
     * 뒤집혀서, 침해된 인게임 서버가 새 id로 결과를 계속 만들어 낼 수 있었다. 이제는 결과를
     * 저장한 매칭 서버가 다음 id를 미리 만들어 보내고, 여기에 그것이 들어와 있어야만 시작한다.
     */
    #grantedMatchId: string | null = null;
    #playedGames = 0;
    #locked = false;
    #countdownEndsAt: number | null = null;
    #postGameEndsAt: number | null = null;
    #startSnapshot: RoomStartSnapshot | null = null;
    /**
     * 지금 돌고 있는(또는 곧 시작할) 경기를 **나중에 들어온 연결에게 다시 알려 주기 위한** 사본.
     *
     * `game.starting`과 `game.started`는 그 순간에 방 전체로 한 번 나가고 끝이었다. 그래서 경기
     * 도중에 재접속하거나 F5로 돌아온 사람은 두 메시지를 영원히 못 받았고, 화면은 "서버의 경기
     * 시작 신호를 기다리고 있습니다"에서 멈춘 채 12초 뒤 실패로 떨어졌다. 방은 멀쩡히 PLAYING인데
     * 본인만 못 들어가는 상태다.
     *
     * `gameplay`가 `game.starting`에만 실려 있다는 점도 같이 걸린다 — 못 받으면 쿨타임 표시와
     * 스킬 사거리 원이 통째로 죽는다. 그래서 둘 다 보관했다가 그대로 다시 보낸다.
     */
    #resumeStarting: Extract<ServerMessage, { type: 'game.starting' }>['payload'] | null = null;
    #resumeStarted: Extract<ServerMessage, { type: 'game.started' }>['payload'] | null = null;

    public constructor(options: RoomOptions) {
        // 새 방은 방장 좌석으로, 넘겨받는 방은 명단으로 시작한다. 둘 다 없으면 아무도 없는
        // 방이 서고, 그건 첫 sweep에 닫힌다 — 조용히 사라지느니 여기서 막는다.
        if (options.ownerReservation === undefined && options.adopted === undefined) {
            throw new Error('room needs either an owner reservation or an adopted roster');
        }
        if (options.ownerReservation !== undefined
            && (options.ownerReservation.roomId !== options.id || options.ownerReservation.resume)) {
            throw new Error('owner reservation must be a fresh seat for this room');
        }
        if (!options.isKnownMap(options.mapId, options.mode)) throw new Error(`unknown map: ${options.mapId}`);
        this.id = options.id;
        this.roomCode = options.roomCode;
        this.#matchId = options.matchId;
        this.mode = options.mode;
        this.name = options.name;
        this.#password = options.password;
        this.#options = options;
        this.#now = options.now ?? Date.now;
        this.#stateMachine = new RoomStateMachine(this.#now());
        this.#roster = new LobbyRoster(options.capacity);
        this.#startLock = new StartLock({
            joinLockMs: options.timing.startLockOnJoinMs,
            joinBudgetMs: options.timing.startLockJoinBudgetMs,
            joinBudgetWindowMs: options.timing.startLockJoinBudgetWindowMs,
            mapLockMs: options.timing.startLockOnMapChangeMs,
        });
        this.#mapId = options.mapId;
        if (options.ownerReservation !== undefined) {
            const held = this.#roster.hold(options.ownerReservation);
            if (!held.ok) throw new Error(`could not reserve owner seat: ${held.reason}`);
        }
    }

    public get state(): RoomStateValue {
        return this.#stateMachine.state;
    }

    public get matchId(): string {
        return this.#matchId;
    }

    public get mapId(): string {
        return this.#mapId;
    }

    public get capacity(): number {
        return this.#roster.capacity;
    }

    public get playerCount(): number {
        return this.#roster.size;
    }

    public get occupiedCount(): number {
        return this.#roster.occupiedSize;
    }

    public get hostId(): number | null {
        return this.#roster.hostId;
    }

    public get isLocked(): boolean {
        return this.#locked;
    }

    public projection(): RoomProjection {
        const hostId = this.#roster.hostId;
        return {
            roomId: this.id,
            roomCode: this.roomCode,
            matchId: this.matchId,
            name: this.name,
            ownerName: hostId === null ? '' : (this.#roster.getByPlayerId(hostId)?.nickname ?? ''),
            mapId: this.#mapId,
            state: this.state,
            playerCount: this.#roster.occupiedSize,
            capacity: this.#roster.capacity,
            hasPassword: this.#password !== null,
            locked: this.#locked,
            mode: this.mode,
        };
    }

    public hasUser(userId: ActorId): boolean {
        return this.#roster.hasUser(userId);
    }

    public isKicked(userId: ActorId): boolean {
        return this.#kickedUsers.has(userId);
    }

    public memberByUser(userId: ActorId): Readonly<LobbyMember> | null {
        return this.#roster.getByUser(userId);
    }

    public reservedPlayerId(userId: ActorId): number | null {
        return this.#roster.heldSeat(userId)?.playerId ?? null;
    }

    public reserveJoin(reservation: Readonly<SeatReservation>, password: string | null): ControlErrorCodeValue | null {
        const now = this.#now();
        this.advance(now);
        if (this.state === RoomState.Closed) return ControlErrorCode.RoomNotFound;
        if (reservation.roomId !== this.id || reservation.resume || reservation.expiresAt <= now) return ControlErrorCode.Expired;
        if ((this.state !== RoomState.Waiting && this.state !== RoomState.Playing) || this.#locked) {
            return ControlErrorCode.RoomLocked;
        }
        if (this.#kickedUsers.has(reservation.userId)) return ControlErrorCode.KickedFromRoom;
        if (this.#password !== null && (password === null || !passwordMatches(this.#password, password))) {
            return ControlErrorCode.BadPassword;
        }
        // 경기 명단은 끝날 때까지 잠겨 있다. 유예가 끝나 방 명단에서 빠진 번호도 현재 world와
        // 리플레이에는 남아 있으므로, 늦게 들어온 사람에게 같은 번호를 주지 않는다.
        const lockedPlayerIds = this.state === RoomState.Playing
            ? new Set(this.#startSnapshot?.players.map((player) => player.playerId) ?? [])
            : undefined;
        const result = lockedPlayerIds === undefined
            ? this.#roster.hold(reservation)
            : this.#roster.hold(reservation, lockedPlayerIds);
        if (!result.ok) return result.reason === 'duplicate' ? ControlErrorCode.AlreadyInRoom : ControlErrorCode.RoomFull;
        this.#directoryChanged();
        return null;
    }

    public canReserveResume(userId: ActorId): ControlErrorCodeValue | null {
        const now = this.#now();
        this.advance(now);
        if (this.state === RoomState.Closed) return ControlErrorCode.RoomNotFound;
        const member = this.#roster.getByUser(userId);
        if (member === null || member.connection !== null || member.admissionPendingUntil !== null) {
            return ControlErrorCode.NoGraceSlot;
        }
        const withinGrace = member.reconnectUntil !== null && member.reconnectUntil > now;
        return withinGrace ? null : ControlErrorCode.NoGraceSlot;
    }

    /** TicketAuthenticator가 티켓을 소비하는 동기 구간에서 호출한다. */
    public admitReservation(reservation: Readonly<SeatReservation>): Admission | null {
        const now = this.#now();
        this.advance(now);
        if (reservation.roomId !== this.id || reservation.expiresAt <= now || this.state === RoomState.Closed) return null;

        if (reservation.resume) {
            if (this.canReserveResume(reservation.userId) !== null) return null;
            const member = this.#roster.getByUser(reservation.userId);
            if (member === null) return null;
            member.admissionPendingUntil = reservation.expiresAt;
            return { playerId: member.playerId, roomState: this.state, role: member.role };
        }

        if (this.state !== RoomState.Allocating && this.state !== RoomState.Waiting
            && this.state !== RoomState.Playing) return null;
        const held = this.#roster.heldSeat(reservation.userId);
        if (held === null
            || held.reservation.issuedAt !== reservation.issuedAt
            || held.reservation.expiresAt !== reservation.expiresAt
            || held.reservation.serverId !== reservation.serverId) return null;
        const role = this.state === RoomState.Playing ? PlayerRole.Waiting : PlayerRole.Player;
        const member = this.#roster.claim(reservation.userId, now, role);
        if (member === null) return null;
        this.#startLock.applyJoin(now);
        if (this.state === RoomState.Allocating) this.#stateMachine.transition(RoomState.Waiting, now);
        this.#directoryChanged();
        return { playerId: member.playerId, roomState: this.state, role: member.role };
    }

    /** 인증 뒤 실제 Connection이 만들어졌을 때 admission을 연결에 결박한다. */
    /**
     * 다른 서버에서 넘어온 방을 이어받는다.
     *
     * 대기실 상태의 방만 넘어온다 — 시뮬레이션이 안 돌고 있어서 옮길 것이 명단과 방 정보뿐이다.
     * 그래서 여기서 하는 일은 명단을 그대로 앉히고 시작 잠금을 다시 거는 것뿐이다.
     *
     * 시작 잠금을 새로 거는 이유: 사람들이 재접속으로 하나씩 돌아오는 중에 방장이 시작을 눌러
     * 버리면 아직 안 돌아온 사람이 경기에서 빠진다. "누가 들어오는 중에는 시작하지 마라"가
     * 원래 이 잠금의 뜻이고, 지금이 정확히 그 상황이다.
     */
    /**
     * 이 방을 다른 서버로 넘길 수 있는가.
     *
     * 대기실일 때만이다. 경기 중이나 카운트다운 중에는 세계가 돌고 있어서, 옮기려면 그것까지
     * 직렬화해야 한다. 그 위험을 감수할 이유가 없다 — 경기가 끝나 대기실로 돌아온 순간이 기회고,
     * 재우는 서버는 어차피 그때까지 기다린다.
     *
     * 사람이 아무도 안 붙어 있는 방은 넘기지 않는다. 곧 스스로 닫힐 방이라 옮길 값이 없다.
     */
    public canHandOff(): boolean {
        return this.state === RoomState.Waiting
            && this.#roster.members().some((member) => member.connection !== null);
    }

    /** 넘길 방의 사본. 소켓은 옮길 수 없으므로 명단만 나간다. */
    public exportForHandOff(targetServerId: string): AdoptRoomPayload {
        const hostId = this.#roster.hostId;
        return {
            serverId: targetServerId,
            roomId: this.id,
            roomCode: this.roomCode,
            matchId: this.matchId,
            name: this.name,
            password: this.#password,
            capacity: this.#roster.capacity,
            mapId: this.#mapId,
            mode: this.mode,
            members: this.#roster.members().map((member) => ({
                userId: member.userId,
                playerId: member.playerId,
                slot: member.slot,
                nickname: member.nickname,
                guest: member.guest,
                stats: member.stats,
                loadout: member.loadout,
                joinedOrder: member.joinedOrder,
                colorIndex: member.colorIndex,
                isHost: member.playerId === hostId,
            })),
        };
    }

    /**
     * 넘기기가 끝났다. 여기 있던 방을 접는다.
     *
     * 소켓을 닫을 때 재시도 가능한 이유를 준다. 클라이언트는 그 코드를 보고 자동 재접속을 도는데,
     * 그 경로가 매칭 서버에 방의 **현재** 서버를 다시 물어보므로 새 서버로 알아서 간다.
     * 그래서 클라이언트에 "방이 옮겨졌다"는 메시지를 따로 보낼 필요가 없다.
     */
    public releaseAfterHandOff(): void {
        for (const member of this.#roster.members()) {
            member.connection?.close(CloseCode.TryAgainLater, 'room migrated');
            member.connection = null;
        }
        this.#stateMachine.transition(RoomState.Closed, this.#now());
    }

    public adoptMembers(members: readonly AdoptedRoomMember[]): void {
        const now = this.#now();
        for (const member of members) {
            this.#roster.adopt(member, now + this.#options.timing.reconnectGraceMs);
        }
        // ALLOCATING은 "첫 사람이 아직 안 앉았다"는 뜻이다. 넘어온 방은 이미 대기실이었고
        // 명단도 그대로다 — 좌석 청구를 거치지 않았다는 이유로 그 상태에 머물면, 방 목록에도
        // 안 뜨고 넘길 수도 없는(canHandOff가 WAITING을 본다) 방이 된다.
        if (this.state === RoomState.Allocating) this.#stateMachine.transition(RoomState.Waiting, now);
        this.#startLock.applyJoin(now);
        this.#directoryChanged();
    }

    public bindConnection(connection: Connection): boolean {
        const now = this.#now();
        const member = this.#roster.getByUser(connection.userId);
        if (member === null || member.playerId !== connection.playerId || member.connection !== null
            || member.admissionPendingUntil === null || member.admissionPendingUntil <= now) return false;
        if (connection.resume !== (member.reconnectUntil !== null)) return false;

        member.connection = connection;
        member.admissionPendingUntil = null;
        member.reconnectUntil = null;
        member.latestInput = null;
        member.lastInputSequence = null;
        this.#options.lifecycle.connectionChanged(this.id, member.playerId, true);

        queueMicrotask(() => {
            if (member.connection !== connection || this.state === RoomState.Closed) return;
            this.broadcastLobbyState();
            // 현재 경기의 잠긴 명단에 든 사람에게만 시작 상태를 복구한다. 경기 중 새로 들어온
            // Waiting 참가자에게 이 메시지를 보내면 대기실 화면을 벗어나고 게임 정보도 샌다.
            if (this.#belongsToLockedGame(member)) this.#replayGameState(connection);
        });
        return true;
    }

    public disconnect(connection: Connection, _reason: string): void {
        const member = this.#roster.getByUser(connection.userId);
        if (member === null || member.connection?.id !== connection.id) return;
        member.connection = null;
        member.admissionPendingUntil = null;
        member.reconnectUntil = this.#now() + this.#options.timing.reconnectGraceMs;
        member.latestInput = null;
        this.#options.lifecycle.connectionChanged(this.id, member.playerId, false);
        const reconnecting = {
            type: 'player.reconnecting',
            payload: { playerId: member.playerId, graceMs: this.#options.timing.reconnectGraceMs },
        } as const;
        if (this.state === RoomState.Playing && member.inCurrentGame) {
            this.#broadcastCurrentGame(reconnecting);
        } else {
            this.#broadcast(reconnecting);
        }
        if (this.state === RoomState.Playing && member.inCurrentGame && !member.spectatorEligible) {
            // 자리 보존 타이머와 탈락 판정은 별개다. 방 쪽 역할을 먼저 바꿔 남은 연결에 알린 뒤,
            // lifecycle이 world를 죽이고 종료 조건ㆍ결과ㆍ리플레이 경로를 즉시 밟게 한다.
            this.#markEliminatedMember(member, member.playerId);
            this.#options.lifecycle.participantDisconnected(this.id, member.playerId);
        } else {
            this.broadcastLobbyState();
        }
    }

    public releaseSeat(userId: ActorId, reason = 'released'): boolean {
        if (this.#roster.releaseHold(userId)) {
            if (this.#roster.occupiedSize === 0) this.close();
            this.#directoryChanged();
            return true;
        }
        return this.#removeMember(userId, reason, true);
    }

    public kick(requester: ActorId, playerId: number): ErrorCodeValue | null {
        if (this.state !== RoomState.Waiting) return ErrorCode.BadState;
        if (!this.#roster.isHost(requester)) return ErrorCode.NotHost;
        const target = this.#roster.getByPlayerId(playerId);
        if (target === null || target.userId === requester) return ErrorCode.InvalidPayload;
        this.#kickedUsers.add(target.userId);
        const connection = target.connection;
        if (connection !== null) this.#sendError(connection, null, ErrorCode.Kicked);
        this.#removeMember(target.userId, 'kicked', true);
        connection?.close(CloseCode.PolicyViolation, 'kicked');
        return null;
    }

    public forceKick(userId: ActorId, reason: string): boolean {
        this.#kickedUsers.add(userId);
        this.#roster.releaseHold(userId);
        const member = this.#roster.getByUser(userId);
        if (member === null) return false;
        const connection = member.connection;
        if (connection !== null) this.#sendError(connection, null, ErrorCode.Kicked);
        this.#removeMember(userId, reason, true);
        connection?.close(CloseCode.PolicyViolation, 'kicked');
        return true;
    }

    public passHost(requester: ActorId, playerId: number): ErrorCodeValue | null {
        if (this.state !== RoomState.Waiting) return ErrorCode.BadState;
        if (!this.#roster.isHost(requester)) return ErrorCode.NotHost;
        if (!this.#roster.passHost(requester, playerId)) return ErrorCode.InvalidPayload;
        this.#broadcast({ type: 'lobby.hostChanged', payload: { hostId: playerId } });
        this.broadcastLobbyState();
        this.#directoryChanged();
        return null;
    }

    public setLocked(requester: ActorId, locked: boolean): ErrorCodeValue | null {
        if (this.state !== RoomState.Waiting) return ErrorCode.BadState;
        if (!this.#roster.isHost(requester)) return ErrorCode.NotHost;
        if (this.#locked !== locked) {
            this.#locked = locked;
            this.broadcastLobbyState();
            this.#directoryChanged();
        }
        return null;
    }

    public setMap(requester: ActorId, mapId: string): ErrorCodeValue | null {
        if (this.state !== RoomState.Waiting) return ErrorCode.BadState;
        if (!this.#roster.isHost(requester)) return ErrorCode.NotHost;
        if (!this.#options.isKnownMap(mapId, this.mode)) return ErrorCode.InvalidPayload;
        if (mapId !== this.#mapId) {
            this.#mapId = mapId;
            this.#startLock.applyMapChange(this.#now());
            this.broadcastLobbyState();
            this.#directoryChanged();
        }
        return null;
    }

    /**
     * 로비 화면에서 만질 수 있는 상태인가. 경기가 끝나고 방으로 돌아온 10초(POST_GAME_MS) 동안
     * 화면은 로비인데 자리도 스킬도 안 바뀌면 사용자에게는 그냥 고장 난 것으로 보인다. 자리와
     * 로드아웃은 다음 `requestStart`에서야 쓰이고 그쪽은 Waiting을 따로 확인하므로, 여기서
     * PostGame을 막을 이유가 없다.
     */
    #lobbyEditable(): boolean {
        return this.state === RoomState.Waiting || this.state === RoomState.PostGame;
    }

    public setLoadout(userId: ActorId, loadout: SkillId): ErrorCodeValue | null {
        if (!this.#lobbyEditable()) return ErrorCode.BadState;
        const member = this.#roster.getByUser(userId);
        if (member === null || member.role !== PlayerRole.Player) return ErrorCode.BadState;
        if (member.loadout !== loadout) {
            member.loadout = loadout;
            this.broadcastLobbyState();
        }
        return null;
    }

    /** shared에 lobby.setSlot이 추가되기 전에도 검증 가능한 순수 roster 동작을 제공한다. */
    public moveSlot(userId: ActorId, slot: number): MoveSlotResult | 'bad-state' {
        if (!this.#lobbyEditable()) return 'bad-state';
        const result = this.#roster.moveSlot(userId, slot);
        if (result === 'moved') this.broadcastLobbyState();
        return result;
    }

    public requestStart(requester: ActorId): ErrorCodeValue | null {
        const now = this.#now();
        if (this.state !== RoomState.Waiting) return ErrorCode.BadState;
        if (!this.#roster.isHost(requester)) return ErrorCode.NotHost;
        if (this.#startLock.remainingMs(now) > 0) return ErrorCode.StartLocked;
        const participants = this.#roster.members().filter((member) => member.connection !== null);
        if (participants.length < this.#options.minPlayersToStart) return ErrorCode.BadState;
        if (this.#options.canStartGame?.() === false) return ErrorCode.ResultBacklog;

        // 재경기는 매칭 서버가 다음 id를 내려준 뒤에만 시작할 수 있다. 아직 안 왔으면 결과가
        // 아직 저장되지 않았다는 뜻이라, outbox가 밀렸을 때와 같은 "잠시 뒤 다시" 응답을 준다.
        //
        // 훈련장은 결과를 내지 않으므로(`GameSession`이 Match 모드에서만 종료 판정을 한다)
        // 발급도 오지 않는다. 여기서 막으면 훈련장을 두 번 시작할 수 없다.
        if (this.#playedGames > 0 && this.mode === RoomMode.Match) {
            if (this.#grantedMatchId === null) return ErrorCode.ResultBacklog;
            this.#matchId = this.#grantedMatchId;
            this.#grantedMatchId = null;
        }

        this.#playedGames += 1;

        this.#roster.clearHolds();
        const players = Object.freeze(participants.map((member) => Object.freeze({
            playerId: member.playerId,
            loadout: member.loadout,
        })));
        this.#startSnapshot = Object.freeze({
            roomId: this.id,
            matchId: this.matchId,
            mapId: this.#mapId,
            mode: this.mode,
            players,
            rules: Object.freeze({ ...this.#options.rules }),
        });
        this.#countdownEndsAt = now + this.#options.timing.countdownMs;
        this.#stateMachine.transition(RoomState.Countdown, now);
        this.#directoryChanged();
        const startsAtTick = this.#options.getServerTick()
            + Math.ceil((this.#options.timing.countdownMs / 1000) * this.#options.simulationHz);
        this.#resumeStarting = Object.freeze({
            startsAtTick,
            countdownMs: this.#options.timing.countdownMs,
            mapId: this.#mapId,
            gameplay: Object.freeze({ ...this.#options.hudGameplay }),
        });
        this.#resumeStarted = null;
        this.#broadcast({ type: 'game.starting', payload: this.#resumeStarting });
        return null;
    }

    public finishGame(winnerIds: readonly number[]): boolean {
        if (this.state !== RoomState.Playing) return false;
        const currentPlayerIds = new Set(this.#startSnapshot?.players.map((player) => player.playerId) ?? []);
        const orderedWinnerIds = [...winnerIds].sort((a, b) => a - b);
        if (orderedWinnerIds.length === 0
            || new Set(orderedWinnerIds).size !== orderedWinnerIds.length
            || orderedWinnerIds.some((playerId) => !currentPlayerIds.has(playerId))) {
            // 내부 호출 경계다. 잘못된 결과를 조용히 전송ㆍ저장하면 복구할 수 없으므로 즉시 드러낸다.
            throw new Error(`invalid winner ids for match ${this.matchId}: ${winnerIds.join(',')}`);
        }
        const now = this.#now();
        this.#postGameEndsAt = now + this.#options.timing.postGameMs;
        this.#stateMachine.transition(RoomState.PostGame, now);
        // 끝난 경기를 다시 알려 주면 안 된다. 이 뒤에 들어온 사람은 결과 화면을 봐야 한다.
        this.#resumeStarting = null;
        this.#resumeStarted = null;
        this.#directoryChanged();
        this.#broadcastCurrentGame({
            type: 'game.ended',
            payload: { matchId: this.matchId, winnerIds: orderedWinnerIds, returnsAt: this.#postGameEndsAt },
        });
        return true;
    }

    /**
     * 훈련장 부활. 탈락으로 관전자가 된 사람을 다시 플레이어로 돌린다.
     *
     * 시뮬레이션에서 `alive`만 되돌리면 안 된다 — `resolvedInputs()`가 `spectatorEligible`인
     * 사람의 입력을 버리기 때문에, 화면에는 살아 있는데 움직이지 않는 상태가 된다.
     * 명단과 시뮬레이션 양쪽을 같이 되돌려야 한다.
     */
    /**
     * 매칭 서버가 내려준 다음 경기 id를 받아 둔다.
     *
     * 같은 발급이 두 번 와도 안전하다 — 명령은 재전달될 수 있고, 덮어써도 둘 다 매칭 서버가
     * 만든 값이라 어느 쪽을 쓰든 발급된 경기다. 이미 시작한 경기의 id는 건드리지 않는다.
     */
    public grantMatchId(matchId: string): void {
        this.#grantedMatchId = matchId;
    }

    public reviveForTraining(playerId: number): boolean {
        if (this.mode !== RoomMode.Training || this.state !== RoomState.Playing) return false;
        const member = this.#roster.getByPlayerId(playerId);
        if (member === null || !member.spectatorEligible) return false;
        member.spectatorEligible = false;
        member.role = PlayerRole.Player;
        member.inCurrentGame = true;
        member.latestInput = null;
        this.#broadcastCurrentGame({ type: 'spectate.changed', payload: { playerId, spectating: false } });
        this.broadcastLobbyState();
        return true;
    }

    public markEliminated(playerId: number, by: number): boolean {
        if (this.state !== RoomState.Playing) return false;
        const member = this.#roster.getByPlayerId(playerId);
        if (member === null || !member.inCurrentGame || member.spectatorEligible) return false;
        this.#markEliminatedMember(member, by);
        return true;
    }

    #markEliminatedMember(member: LobbyMember, by: number): void {
        member.spectatorEligible = true;
        member.role = PlayerRole.Spectator;
        member.latestInput = null;
        this.#broadcastCurrentGame({
            type: 'player.eliminated', payload: { playerId: member.playerId, by },
        });
        this.#broadcastCurrentGame({
            type: 'spectate.changed', payload: { playerId: member.playerId, spectating: true },
        });
        this.broadcastLobbyState();
    }

    public setSpectating(userId: ActorId, spectating: boolean): ErrorCodeValue | null {
        if (this.state !== RoomState.Playing) return ErrorCode.BadState;
        const member = this.#roster.getByUser(userId);
        if (member === null || !member.spectatorEligible) return ErrorCode.SpectateDenied;
        const nextRole = spectating ? PlayerRole.Spectator : PlayerRole.Waiting;
        if (member.role !== nextRole) {
            member.role = nextRole;
            member.latestInput = null;
            this.#broadcastCurrentGame({
                type: 'spectate.changed', payload: { playerId: member.playerId, spectating },
            });
            this.broadcastLobbyState();
        }
        return null;
    }

    /**
     * 이번 tick에 스냅샷을 받을 연결들. 조립 계층(game/)이 여기서만 연결을 얻는다.
     *
     * 검열 등급을 함께 준다. 이걸 나눠 주면 호출하는 쪽이 "이 사람 관전자였나?"를 다시 판정하게 되고,
     * 판정이 두 곳으로 갈리는 순간 한쪽만 고쳐져 시야가 샌다.
     */
    public snapshotTargets(): { playerId: number; connection: Connection; access: SnapshotAccess }[] {
        if (this.state !== RoomState.Playing) return [];
        const targets: { playerId: number; connection: Connection; access: SnapshotAccess }[] = [];
        for (const member of this.#roster.members()) {
            if (member.connection === null) continue;
            const access = this.snapshotAccess(member.userId);
            if (access === 'none') continue;
            targets.push({ playerId: member.playerId, connection: member.connection, access });
        }
        return targets;
    }

    /**
     * 경기 결과에 실을 참가자 신원. 게스트도 포함한다.
     *
     * 게스트를 빼면 리플레이에 이름 없는 캐릭터가 돌아다니고, 신고 조사도 slot을 계정으로 잇지 못한다.
     * 전적 집계에서만 제외하는 것이지 기록에서 빼는 게 아니다.
     */
    public participants(): { playerId: number; userId: ActorId; nickname: string; colorIndex: number; guest: boolean }[] {
        return this.#roster.members().map((member) => ({
            playerId: member.playerId,
            userId: member.userId,
            nickname: member.nickname,
            colorIndex: member.colorIndex,
            guest: member.guest,
        }));
    }

    /** ROSTER 섹션에 실을 이름. 클라이언트가 보낸 값이 아니라 티켓에 실려 온 값이다. */
    public nicknameOf(playerId: number): string | null {
        return this.#roster.getByPlayerId(playerId)?.nickname ?? null;
    }

    /** 술래가 바뀌었다. 시뮬레이션이 판정하고 방은 알리기만 한다. */
    public broadcastTagged(playerId: number, by: number | null): void {
        this.#broadcastCurrentGame({ type: 'player.tagged', payload: { playerId, by: by ?? playerId } });
    }

    /**
     * 점멸 연출. 저빈도라 바이너리 섹션이 아니라 JSON으로 나간다.
     *
     * **시야로 거른다.** 이 메시지는 좌표를 싣기 때문에, 방 전체로 뿌리면 스냅샷에서 지운
     * 위치가 그대로 새어 나간다. 정직한 클라이언트가 안 그리는 것에 기대는 것은 방어가 아니다.
     */
    public broadcastBlinked(playerId: number, fromX: number, fromY: number, canSee: ViewerFilter): void {
        this.#broadcastToViewers({ type: 'player.blinked', payload: { playerId, fromX, fromY } }, playerId, canSee);
    }

    /**
     * 사거리 스킬(스위치·탈진) 연출. 빗나간 것도 나간다.
     *
     * `player.blinked`와 같은 이유로 시야를 거친다. 시전자를 못 보는 사람에게 원의 중심을 주면
     * 그것이 곧 좌표다.
     */
    public broadcastSkillArea(
        skill: string, playerId: number, x: number, y: number, targetPlayerId: number | null, canSee: ViewerFilter,
    ): void {
        this.#broadcastToViewers(
            { type: 'player.skillArea', payload: { skill, playerId, x, y, targetPlayerId } },
            playerId,
            canSee,
        );
    }

    /** Skill failures contain private tactical information, so they never use the room broadcaster. */
    public sendSkillRejected(playerId: number, slot: number, reason: SkillRejection): void {
        this.#roster.getByPlayerId(playerId)?.connection?.sendJson({
            type: 'skill.rejected',
            payload: { slot, reason },
        });
    }

    /** 스냅샷 인코딩 직전 이 한 메서드만 보고 검열 등급을 고른다. */
    public snapshotAccess(userId: ActorId): SnapshotAccess {
        if (this.state !== RoomState.Playing) return 'none';
        const member = this.#roster.getByUser(userId);
        if (member === null || member.connection === null) return 'none';
        if (member.role === PlayerRole.Spectator && member.spectatorEligible) return 'unfiltered';
        if (member.role === PlayerRole.Player && member.inCurrentGame && !member.spectatorEligible) return 'filtered';
        return 'none';
    }

    public acceptInput(connection: Connection, input: InputState): boolean {
        const member = this.#roster.getByUser(connection.userId);
        if (this.state !== RoomState.Playing || member === null || member.connection?.id !== connection.id
            || member.role !== PlayerRole.Player || member.spectatorEligible) return false;
        if (member.lastInputSequence !== null && !isNewerSequence(input.sequence, member.lastInputSequence)) return false;
        member.lastInputSequence = input.sequence;
        member.latestInput = input;
        return true;
    }

    /** 시뮬레이션 tick마다 최신 상태를 읽는다. 새 패킷이 없어도 held input은 유지된다. */
    public resolvedInputs(): ResolvedInput[] {
        if (this.state !== RoomState.Playing) return [];
        const result: ResolvedInput[] = [];
        for (const member of this.#roster.members()) {
            if (member.connection === null || member.role !== PlayerRole.Player || member.spectatorEligible
                || member.latestInput === null || member.lastInputSequence === null) continue;
            const movement = movementVector(member.latestInput);
            result.push({
                playerId: member.playerId,
                moveX: movement.x,
                moveY: movement.y,
                heldActions: member.latestInput.heldActions,
                lastProcessedSequence: member.lastInputSequence,
            });
        }
        return result;
    }

    public broadcastLobbyState(): void {
        if (this.state === RoomState.Closed || this.#roster.hostId === null) return;
        const players: LobbyPlayer[] = this.#roster.members().map((member) => ({
            playerId: member.playerId,
            slot: member.slot,
            nickname: member.nickname,
            colorIndex: member.colorIndex,
            guest: member.guest,
            role: member.role,
            skills: [member.loadout],
            stats: member.stats,
        }));
        this.#broadcast({
            type: 'lobby.state',
            payload: {
                hostId: this.#roster.hostId,
                roomName: this.name,
                mapId: this.#mapId,
                mode: this.mode,
                capacity: this.#roster.capacity,
                locked: this.#locked,
                startLockMs: this.#startLock.remainingMs(this.#now()),
                players,
            },
        });
    }

    public advance(now: number = this.#now()): void {
        const before = this.#directoryState();
        try {
            this.#advance(now);
        } finally {
            if (before !== this.#directoryState()) this.#directoryChanged();
        }
    }

    #advance(now: number): void {
        if (this.state === RoomState.Closed) return;
        this.#roster.purgeExpiredHolds(now);

        for (const member of this.#roster.members()) {
            if (member.connection === null && member.admissionPendingUntil !== null && member.admissionPendingUntil <= now) {
                member.admissionPendingUntil = null;
                if (member.reconnectUntil === null) {
                    this.#removeMember(member.userId, 'admission-timeout', false);
                    continue;
                }
            }
            if (member.connection === null && member.reconnectUntil !== null && member.reconnectUntil <= now) {
                // 탈락은 disconnect 순간에 이미 끝났다. 여기서는 정확히 5초 동안 보존한 자리만
                // 놓는다. 인증 중인 새 소켓도 이 시각을 넘겼다면 보존을 연장하지 않는다.
                this.#removeMember(member.userId, 'reconnect-timeout', false);
            }
        }

        if (this.#roster.size === 0) {
            if (this.state !== RoomState.Allocating || this.#roster.occupiedSize === 0) this.close();
            return;
        }

        if (this.state === RoomState.Countdown && this.#countdownEndsAt !== null && now >= this.#countdownEndsAt) {
            const snapshot = this.#startSnapshot;
            if (snapshot === null) throw new Error('countdown has no locked start snapshot');
            const started = this.#options.lifecycle.startGame(snapshot);
            for (const member of this.#roster.members()) {
                member.inCurrentGame = snapshot.players.some((player) => player.playerId === member.playerId);
                member.role = member.inCurrentGame ? PlayerRole.Player : PlayerRole.Waiting;
                member.spectatorEligible = false;
                member.latestInput = null;
            }
            this.#countdownEndsAt = null;
            this.#stateMachine.transition(RoomState.Playing, now);
            this.#resumeStarted = Object.freeze({ startTick: started.startTick, taggerId: started.taggerId });
            this.#broadcastCurrentGame({ type: 'game.started', payload: this.#resumeStarted });
            this.broadcastLobbyState();
        }

        if (this.state === RoomState.PostGame && this.#postGameEndsAt !== null && now >= this.#postGameEndsAt) {
            for (const member of this.#roster.members()) {
                member.role = PlayerRole.Player;
                member.spectatorEligible = false;
                member.inCurrentGame = false;
                member.latestInput = null;
            }
            this.#postGameEndsAt = null;
            this.#startSnapshot = null;
            this.#stateMachine.transition(RoomState.Waiting, now);
            this.broadcastLobbyState();
        }
    }

    public close(): void {
        if (this.state === RoomState.Closed) return;
        this.#options.lifecycle.stopRoom(this.id);
        this.#roster.clearHolds();
        for (const member of this.#roster.members()) {
            member.connection?.close(CloseCode.Normal, 'room closed');
        }
        this.#stateMachine.transition(RoomState.Closed, this.#now());
        this.#directoryChanged();
    }

    public sendError(connection: Connection, requestId: number | null, code: ErrorCodeValue): void {
        this.#sendError(connection, requestId, code);
    }

    #removeMember(userId: ActorId, reason: string, notifyLifecycle: boolean): boolean {
        const removed = this.#roster.remove(userId);
        if (removed === null) return false;
        if (notifyLifecycle) this.#options.lifecycle.participantRemoved(this.id, removed.member.playerId, reason);
        this.#broadcast({ type: 'player.left', payload: { playerId: removed.member.playerId, reason } });
        this.#directoryChanged();
        if (removed.hostChanged && this.#roster.hostId !== null) {
            this.#broadcast({ type: 'lobby.hostChanged', payload: { hostId: this.#roster.hostId } });
        }
        if (this.#roster.size === 0) this.close();
        else this.broadcastLobbyState();
        return true;
    }

    #directoryState(): string {
        return JSON.stringify(this.projection());
    }

    #directoryChanged(): void {
        this.#options.onDirectoryChanged?.();
    }

    #sendError(connection: Connection, requestId: number | null, code: ErrorCodeValue): void {
        connection.sendJson({ type: 'error', payload: { requestId, code, retryable: isRetryable(code) } });
    }

    /**
     * 이미 시작한 경기를 방금 붙은 연결 하나에게만 다시 알린다.
     *
     * 두 메시지를 원래 순서대로 보낸다. `game.starting`이 클라이언트를 Countdown으로,
     * `game.started`가 다시 Playing으로 놓기 때문에 순서가 뒤집히면 카운트다운에 멈춰 선다.
     *
     * 경기 중이면 `countdownMs`를 0으로 바꿔 보낸다. 카운트다운은 이미 끝났고, 남은 시간인 척하는
     * 값을 보내면 언젠가 그걸 읽는 화면이 생겼을 때 조용히 틀린다. `startsAtTick`은 절대 tick이라
     * 그대로 유효하다.
     */
    #replayGameState(connection: Connection): void {
        const starting = this.#resumeStarting;
        if (starting === null) return;
        connection.sendJson({
            type: 'game.starting',
            payload: this.state === RoomState.Playing ? { ...starting, countdownMs: 0 } : starting,
        });
        if (this.#resumeStarted !== null) {
            connection.sendJson({ type: 'game.started', payload: this.#resumeStarted });
        }
    }

    #broadcast(message: Parameters<Connection['sendJson']>[0]): void {
        for (const member of this.#roster.members()) member.connection?.sendJson(message);
    }

    /** 현재 경기의 잠긴 명단에 든 사람에게만 게임 이벤트를 보낸다. */
    #broadcastCurrentGame(message: Parameters<Connection['sendJson']>[0]): void {
        for (const member of this.#roster.members()) {
            if (member.inCurrentGame) member.connection?.sendJson(message);
        }
    }

    #belongsToLockedGame(member: LobbyMember): boolean {
        return this.#startSnapshot?.players.some((player) => player.playerId === member.playerId) ?? false;
    }

    /**
     * 좌표를 싣는 연출을 볼 사람에게만 보낸다.
     *
     * 검열 등급은 스냅샷과 같은 판정(`snapshotAccess`)을 쓴다 - 관전자는 전부 보고, 경기 중인
     * 사람은 자기 시야만 보며, 아무 등급도 없는 사람은 애초에 세계를 안 받는다. 시전자 본인은
     * 언제나 받는다.
     */
    #broadcastToViewers(
        message: Parameters<Connection['sendJson']>[0],
        sourcePlayerId: number,
        canSee: ViewerFilter,
    ): void {
        for (const member of this.#roster.members()) {
            if (member.connection === null) continue;
            const access = this.snapshotAccess(member.userId);
            if (access === 'none') continue;
            if (access === 'filtered' && member.playerId !== sourcePlayerId && !canSee(member.playerId)) continue;
            member.connection.sendJson(message);
        }
    }
}
