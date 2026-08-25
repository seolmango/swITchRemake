import {
    MAX_PLAYERS_PER_ROOM,
    SkillId,
    PlayerRole,
    type ActorId,
    type InputState,
    type LobbyStats,
    type PlayerRole as PlayerRoleValue,
} from 'shared';
import type { SeatReservation } from '../gateway/ticket-store';
import type { Connection } from '../transport/game-transport';

export interface SeatHold {
    readonly reservation: Readonly<SeatReservation>;
    readonly playerId: number;
    readonly slot: number;
}

export interface LobbyMember {
    readonly userId: ActorId;
    /**
     * 대기실에서 고르는 자리 번호이자 인게임 번호다. `slot`과 항상 같은 값이며 둘을 따로 두지 않는다.
     * 예전에는 "playerId는 고정하고 대기실 자리만 옮긴다"였는데, 그러면 대기실에서 6번을 고른 사람이
     * 인게임에서 3번으로 나오고 다른 사람이 스위치하려고 누르는 숫자도 달라진다. 실제로 그랬다.
     */
    playerId: number;
    slot: number;
    readonly nickname: string;
    readonly guest: boolean;
    readonly stats: LobbyStats | null;
    /**
     * 2번 슬롯에 넣을 스킬. `lobby.setLoadout`이 이 값을 바꾼다.
     *
     * 기본값이 대시인 것은 선택이 아니라 자리를 채우는 값이다 — 지금은 `lobby.setLoadout` 처리가
     * 아직 없어서 모두가 대시로 시작한다(T0). 그 전까지 `game-lifecycle`이 하드코딩하던 것을
     * 여기로 옮겨, 로드아웃이 붙을 자리를 한 곳으로 모았다.
     */
    loadout: SkillId;
    readonly joinedOrder: number;
    colorIndex: number;
    role: PlayerRoleValue;
    spectatorEligible: boolean;
    inCurrentGame: boolean;
    connection: Connection | null;
    /** admitReservation과 onConnect 사이의 짧은 구간을 나타낸다. */
    admissionPendingUntil: number | null;
    reconnectUntil: number | null;
    latestInput: InputState | null;
    lastInputSequence: number | null;
}

export type HoldFailure = 'duplicate' | 'full';

export type HoldResult =
    | { ok: true; playerId: number }
    | { ok: false; reason: HoldFailure };

export type MoveSlotResult = 'moved' | 'not-found' | 'out-of-range' | 'occupied';

/**
 * 참가자와 아직 인증되지 않은 자리 예약을 함께 세어 정원을 보장한다.
 * `userId`는 이 계층 밖으로 직렬화하지 않는다.
 */
export class LobbyRoster {
    readonly #capacity: number;
    readonly #holds = new Map<ActorId, SeatHold>();
    readonly #members = new Map<ActorId, LobbyMember>();
    #joinOrder = 0;
    #hostUserId: ActorId | null = null;

    public constructor(capacity: number) {
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_PLAYERS_PER_ROOM) {
            throw new Error(`capacity must be between 1 and ${MAX_PLAYERS_PER_ROOM}`);
        }
        this.#capacity = capacity;
    }

    public get capacity(): number {
        return this.#capacity;
    }

    public get size(): number {
        return this.#members.size;
    }

    public get occupiedSize(): number {
        return this.#members.size + this.#holds.size;
    }

    public get hostId(): number | null {
        if (this.#hostUserId === null) return null;
        return this.#members.get(this.#hostUserId)?.playerId ?? null;
    }

    public members(): LobbyMember[] {
        return [...this.#members.values()].sort((a, b) => a.joinedOrder - b.joinedOrder);
    }

    public getByUser(userId: ActorId): LobbyMember | null {
        return this.#members.get(userId) ?? null;
    }

    public getByPlayerId(playerId: number): LobbyMember | null {
        return this.members().find((member) => member.playerId === playerId) ?? null;
    }

    public hasUser(userId: ActorId): boolean {
        return this.#members.has(userId) || this.#holds.has(userId);
    }

    public hold(reservation: Readonly<SeatReservation>): HoldResult {
        if (this.hasUser(reservation.userId)) return { ok: false, reason: 'duplicate' };
        const seat = this.#firstFreeSeat();
        if (seat === null) return { ok: false, reason: 'full' };
        this.#holds.set(reservation.userId, { reservation, playerId: seat, slot: seat });
        return { ok: true, playerId: seat };
    }

    public heldSeat(userId: ActorId): SeatHold | null {
        return this.#holds.get(userId) ?? null;
    }

    public claim(userId: ActorId, now: number, role: PlayerRoleValue): LobbyMember | null {
        const hold = this.#holds.get(userId);
        if (hold === undefined || hold.reservation.expiresAt <= now) {
            if (hold !== undefined) this.#holds.delete(userId);
            return null;
        }
        this.#holds.delete(userId);
        const member: LobbyMember = {
            userId,
            playerId: hold.playerId,
            slot: hold.slot,
            nickname: hold.reservation.nickname,
            guest: typeof userId === 'string',
            stats: hold.reservation.lobbyStats,
            loadout: SkillId.Dash,
            joinedOrder: this.#joinOrder++,
            // playerId is 1..8; palette colorIndex is intentionally 0..7.
            colorIndex: hold.playerId - 1,
            role,
            spectatorEligible: role === PlayerRole.Waiting,
            inCurrentGame: role === PlayerRole.Player,
            connection: null,
            admissionPendingUntil: hold.reservation.expiresAt,
            reconnectUntil: null,
            latestInput: null,
            lastInputSequence: null,
        };
        this.#members.set(userId, member);
        if (this.#hostUserId === null) this.#hostUserId = userId;
        return member;
    }

    public releaseHold(userId: ActorId): boolean {
        return this.#holds.delete(userId);
    }

    public clearHolds(): void {
        this.#holds.clear();
    }

    public purgeExpiredHolds(now: number): number {
        let removed = 0;
        for (const [userId, hold] of this.#holds) {
            if (hold.reservation.expiresAt <= now) {
                this.#holds.delete(userId);
                removed += 1;
            }
        }
        return removed;
    }

    public remove(userId: ActorId): { member: LobbyMember; hostChanged: boolean } | null {
        const member = this.#members.get(userId);
        if (member === undefined) return null;
        this.#members.delete(userId);
        const hostChanged = this.#hostUserId === userId;
        if (hostChanged) this.#hostUserId = this.members()[0]?.userId ?? null;
        return { member, hostChanged };
    }

    public passHost(requester: ActorId, playerId: number): boolean {
        if (this.#hostUserId !== requester) return false;
        const target = this.getByPlayerId(playerId);
        if (target === null) return false;
        this.#hostUserId = target.userId;
        return true;
    }

    public isHost(userId: ActorId): boolean {
        return this.#hostUserId === userId;
    }

    /**
     * 자리를 옮기면 인게임 번호와 색도 같이 간다. 대기실에서 보이는 숫자, 몸에 찍히는 숫자,
     * 남이 스위치하려고 누르는 숫자가 전부 같아야 한다.
     *
     * 경기 중에는 호출되지 않는다(Room이 Waiting/PostGame에서만 받는다). 그래서 시뮬레이션이
     * 도는 도중에 playerId가 바뀌는 일은 없다.
     */
    public moveSlot(userId: ActorId, target: number): MoveSlotResult {
        const member = this.#members.get(userId);
        if (member === undefined) return 'not-found';
        if (!Number.isInteger(target) || target < 1 || target > this.#capacity) return 'out-of-range';
        if (this.#slotOccupied(target, userId)) return 'occupied';
        member.slot = target;
        member.playerId = target;
        // playerId is 1..8; palette colorIndex is intentionally 0..7.
        member.colorIndex = target - 1;
        return 'moved';
    }

    /** 자리 번호는 playerId이기도 하므로 탐색이 하나다. 둘로 나뉘어 있을 때 서로 어긋났다. */
    #firstFreeSeat(): number | null {
        const limit = Math.min(this.#capacity, MAX_PLAYERS_PER_ROOM);
        for (let seat = 1; seat <= limit; seat += 1) {
            if (!this.#slotOccupied(seat)) return seat;
        }
        return null;
    }

    #slotOccupied(slot: number, exceptUserId?: ActorId): boolean {
        for (const hold of this.#holds.values()) {
            if (hold.reservation.userId !== exceptUserId && hold.slot === slot) return true;
        }
        for (const member of this.#members.values()) {
            if (member.userId !== exceptUserId && member.slot === slot) return true;
        }
        return false;
    }
}

interface LockGrant {
    readonly at: number;
    readonly durationMs: number;
}

/** 참가 잠금의 rolling budget과 맵 잠금을 서로 섞지 않는다. */
export class StartLock {
    readonly #joinLockMs: number;
    readonly #joinBudgetMs: number;
    readonly #joinBudgetWindowMs: number;
    readonly #mapLockMs: number;
    readonly #joinGrants: LockGrant[] = [];
    #unlocksAt = 0;

    public constructor(options: {
        joinLockMs: number;
        joinBudgetMs: number;
        joinBudgetWindowMs: number;
        mapLockMs: number;
    }) {
        this.#joinLockMs = options.joinLockMs;
        this.#joinBudgetMs = options.joinBudgetMs;
        this.#joinBudgetWindowMs = options.joinBudgetWindowMs;
        this.#mapLockMs = options.mapLockMs;
    }

    public applyJoin(now: number): number {
        this.#prune(now);
        const used = this.#joinGrants.reduce((sum, grant) => sum + grant.durationMs, 0);
        const grant = Math.min(this.#joinLockMs, Math.max(0, this.#joinBudgetMs - used));
        if (grant > 0) {
            this.#joinGrants.push({ at: now, durationMs: grant });
            this.#unlocksAt = Math.max(this.#unlocksAt, now + grant);
        }
        return grant;
    }

    public applyMapChange(now: number): void {
        this.#unlocksAt = Math.max(this.#unlocksAt, now + this.#mapLockMs);
    }

    public remainingMs(now: number): number {
        return Math.max(0, this.#unlocksAt - now);
    }

    #prune(now: number): void {
        while (this.#joinGrants[0] !== undefined && now - this.#joinGrants[0].at >= this.#joinBudgetWindowMs) {
            this.#joinGrants.shift();
        }
    }
}
