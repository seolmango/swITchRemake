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
    type ActorId,
    type ControlErrorCode as ControlErrorCodeValue,
    type ErrorCode as ErrorCodeValue,
    type InputState,
    type LobbyPlayer,
    type PlayerRole as PlayerRoleValue,
    type RoomState as RoomStateValue,
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
    readonly players: readonly RoomStartPlayer[];
    readonly rules: Readonly<Record<string, number | string | boolean>>;
}

export interface GameStartInfo {
    readonly startTick: number;
    readonly taggerId: number;
}

/**
 * 방 수명과 시뮬레이션의 좁은 연결점. 누가 술래인지, 유예 만료가 탈락인지 퇴장인지는
 * rooms가 판정하지 않고 시뮬레이션 조립 계층에 알린다.
 */
export interface RoomLifecyclePort {
    startGame(snapshot: RoomStartSnapshot): GameStartInfo;
    connectionChanged(roomId: string, playerId: number, connected: boolean): void;
    participantTimedOut(roomId: string, playerId: number): void;
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
    readonly capacity: number;
    readonly mapId: string;
    readonly ownerReservation: Readonly<SeatReservation>;
    readonly minPlayersToStart: number;
    readonly simulationHz: number;
    readonly rules: Readonly<Record<string, number | string | boolean>>;
    readonly hudGameplay: Readonly<Record<string, number>>;
    readonly timing: RoomTiming;
    readonly lifecycle: RoomLifecyclePort;
    readonly isKnownMap: (mapId: string) => boolean;
    readonly getServerTick: () => number;
    /** Notifies the directory publisher after a room-list-visible change. */
    readonly onDirectoryChanged?: () => void;
    readonly now?: () => number;
}

export type SnapshotAccess = 'none' | 'filtered' | 'unfiltered';

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
    readonly matchId: string;
    readonly name: string;
    readonly #password: string | null;
    readonly #options: RoomOptions;
    readonly #now: () => number;
    readonly #stateMachine: RoomStateMachine;
    readonly #roster: LobbyRoster;
    readonly #startLock: StartLock;
    readonly #kickedUsers = new Set<ActorId>();
    #mapId: string;
    #locked = false;
    #countdownEndsAt: number | null = null;
    #postGameEndsAt: number | null = null;
    #startSnapshot: RoomStartSnapshot | null = null;

    public constructor(options: RoomOptions) {
        if (options.ownerReservation.roomId !== options.id || options.ownerReservation.resume) {
            throw new Error('owner reservation must be a fresh seat for this room');
        }
        if (!options.isKnownMap(options.mapId)) throw new Error(`unknown map: ${options.mapId}`);
        this.id = options.id;
        this.roomCode = options.roomCode;
        this.matchId = options.matchId;
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
        const held = this.#roster.hold(options.ownerReservation);
        if (!held.ok) throw new Error(`could not reserve owner seat: ${held.reason}`);
    }

    public get state(): RoomStateValue {
        return this.#stateMachine.state;
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
        if (this.state !== RoomState.Waiting || this.#locked) return ControlErrorCode.RoomLocked;
        if (this.#kickedUsers.has(reservation.userId)) return ControlErrorCode.KickedFromRoom;
        if (this.#password !== null && (password === null || !passwordMatches(this.#password, password))) {
            return ControlErrorCode.BadPassword;
        }
        const result = this.#roster.hold(reservation);
        if (!result.ok) return result.reason === 'duplicate' ? ControlErrorCode.AlreadyInRoom : ControlErrorCode.RoomFull;
        this.#directoryChanged();
        return null;
    }

    public canReserveResume(userId: ActorId): ControlErrorCodeValue | null {
        const now = this.#now();
        this.advance(now);
        if (this.state === RoomState.Closed) return ControlErrorCode.RoomNotFound;
        const member = this.#roster.getByUser(userId);
        if (member === null || member.connection !== null || member.admissionPendingUntil !== null
            || member.reconnectUntil === null || member.reconnectUntil <= now) {
            return ControlErrorCode.NoGraceSlot;
        }
        return null;
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

        if (this.state !== RoomState.Allocating && this.state !== RoomState.Waiting) return null;
        const held = this.#roster.heldSeat(reservation.userId);
        if (held === null
            || held.reservation.issuedAt !== reservation.issuedAt
            || held.reservation.expiresAt !== reservation.expiresAt
            || held.reservation.serverId !== reservation.serverId) return null;
        const role = PlayerRole.Player;
        const member = this.#roster.claim(reservation.userId, now, role);
        if (member === null) return null;
        this.#startLock.applyJoin(now);
        if (this.state === RoomState.Allocating) this.#stateMachine.transition(RoomState.Waiting, now);
        this.#directoryChanged();
        return { playerId: member.playerId, roomState: this.state, role: member.role };
    }

    /** 인증 뒤 실제 Connection이 만들어졌을 때 admission을 연결에 결박한다. */
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
            if (member.connection === connection && this.state !== RoomState.Closed) this.broadcastLobbyState();
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
        this.#broadcast({
            type: 'player.reconnecting',
            payload: { playerId: member.playerId, graceMs: this.#options.timing.reconnectGraceMs },
        });
        this.broadcastLobbyState();
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
        if (!this.#options.isKnownMap(mapId)) return ErrorCode.InvalidPayload;
        if (mapId !== this.#mapId) {
            this.#mapId = mapId;
            this.#startLock.applyMapChange(this.#now());
            this.broadcastLobbyState();
            this.#directoryChanged();
        }
        return null;
    }

    public setLoadout(userId: ActorId, loadout: SkillId): ErrorCodeValue | null {
        if (this.state !== RoomState.Waiting) return ErrorCode.BadState;
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
        if (this.state !== RoomState.Waiting) return 'bad-state';
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

        this.#roster.clearHolds();
        const players = Object.freeze(participants.map((member) => Object.freeze({
            playerId: member.playerId,
            loadout: member.loadout,
        })));
        this.#startSnapshot = Object.freeze({
            roomId: this.id,
            matchId: this.matchId,
            mapId: this.#mapId,
            players,
            rules: Object.freeze({ ...this.#options.rules }),
        });
        this.#countdownEndsAt = now + this.#options.timing.countdownMs;
        this.#stateMachine.transition(RoomState.Countdown, now);
        this.#directoryChanged();
        const startsAtTick = this.#options.getServerTick()
            + Math.ceil((this.#options.timing.countdownMs / 1000) * this.#options.simulationHz);
        this.#broadcast({
            type: 'game.starting',
            payload: {
                startsAtTick,
                countdownMs: this.#options.timing.countdownMs,
                mapId: this.#mapId,
                gameplay: { ...this.#options.hudGameplay },
            },
        });
        return null;
    }

    public finishGame(winnerIds: readonly [number, number]): boolean {
        if (this.state !== RoomState.Playing) return false;
        const now = this.#now();
        this.#postGameEndsAt = now + this.#options.timing.postGameMs;
        this.#stateMachine.transition(RoomState.PostGame, now);
        this.#directoryChanged();
        this.#broadcast({
            type: 'game.ended',
            payload: { matchId: this.matchId, winnerIds: [winnerIds[0], winnerIds[1]], returnsAt: this.#postGameEndsAt },
        });
        return true;
    }

    public markEliminated(playerId: number, by: number): boolean {
        if (this.state !== RoomState.Playing) return false;
        const member = this.#roster.getByPlayerId(playerId);
        if (member === null || !member.inCurrentGame || member.spectatorEligible) return false;
        member.spectatorEligible = true;
        member.role = PlayerRole.Spectator;
        member.latestInput = null;
        this.#broadcast({ type: 'player.eliminated', payload: { playerId, by } });
        this.#broadcast({ type: 'spectate.changed', payload: { playerId, spectating: true } });
        this.broadcastLobbyState();
        return true;
    }

    public setSpectating(userId: ActorId, spectating: boolean): ErrorCodeValue | null {
        if (this.state !== RoomState.Playing) return ErrorCode.BadState;
        const member = this.#roster.getByUser(userId);
        if (member === null || !member.spectatorEligible) return ErrorCode.SpectateDenied;
        const nextRole = spectating ? PlayerRole.Spectator : PlayerRole.Waiting;
        if (member.role !== nextRole) {
            member.role = nextRole;
            member.latestInput = null;
            this.#broadcast({ type: 'spectate.changed', payload: { playerId: member.playerId, spectating } });
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
        this.#broadcast({ type: 'player.tagged', payload: { playerId, by: by ?? playerId } });
    }

    /** 점멸 연출. 저빈도라 바이너리 섹션이 아니라 JSON으로 나간다. */
    public broadcastBlinked(playerId: number, fromX: number, fromY: number): void {
        this.#broadcast({ type: 'player.blinked', payload: { playerId, fromX, fromY } });
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
        }));
        this.#broadcast({
            type: 'lobby.state',
            payload: {
                hostId: this.#roster.hostId,
                roomName: this.name,
                mapId: this.#mapId,
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
            if (member.connection === null && member.admissionPendingUntil === null
                && member.reconnectUntil !== null && member.reconnectUntil <= now) {
                this.#options.lifecycle.participantTimedOut(this.id, member.playerId);
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
                member.spectatorEligible = !member.inCurrentGame;
                member.latestInput = null;
            }
            this.#countdownEndsAt = null;
            this.#stateMachine.transition(RoomState.Playing, now);
            this.#broadcast({ type: 'game.started', payload: { startTick: started.startTick, taggerId: started.taggerId } });
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

    #broadcast(message: Parameters<Connection['sendJson']>[0]): void {
        for (const member of this.#roster.members()) member.connection?.sendJson(message);
    }
}
