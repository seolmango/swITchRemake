import {
    HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_TTL_MS,
    RoomMode,
    RoomState,
    type ActorId,
    type GameServerHeartbeat,
    type RedisKeys,
} from 'shared';
import type { RoomManager } from '../rooms/room-manager';
import type { RoomProjection } from '../rooms/room';
import type { RedisPort } from './redis-client';

const ACTIVE_ROOM_TTL_MS = 30_000;
const REJOIN_COOLDOWN_MS = 60_000;
const KICK_MARKER_PREFIX = 'room-kicked';

export interface HeartbeatSource {
    readonly serverId: string;
    readonly buildVersion: string;
    readonly protocolVersion: number;
    readonly rulesVersion: string;
    readonly mapBundleHash: string;
    /** 게이트웨이가 이 서버에 닿는 주소. 포트가 0으로 뜨는 경우가 있어 listen 뒤에 읽는다. */
    internalAddress(): string;
    readonly maxRooms: number;
    connectionCount(): number;
    loopLagMs(): number;
    isDraining(): boolean;
}

export interface RegistryOptions {
    readonly redis: RedisPort;
    readonly keys: RedisKeys;
    readonly rooms: RoomManager;
    readonly heartbeat: HeartbeatSource;
    readonly now?: () => number;
    readonly logger?: (message: string, error?: unknown) => void;
}

interface TrackedSeat {
    joined: boolean;
    readonly requestId: string;
}

interface PendingRelease {
    readonly roomId: string;
    readonly userId: ActorId;
    readonly cooldown: boolean;
    readonly kicked: boolean;
    readonly releasedAt: number;
}

export interface RoomDirectoryValue extends RoomProjection {
    readonly serverId: string;
    /** A1 room directory가 읽는 필드 이름. */
    readonly status: RoomProjection['state'];
    readonly updatedAt: number;
}

function actorKey(userId: ActorId): string {
    return `${typeof userId}:${String(userId)}`;
}

function releaseKey(roomId: string, userId: ActorId): string {
    return `${roomId}\u0000${actorKey(userId)}`;
}

/** heartbeat, room directory, 한 사용자 한 방 lease를 한 주기로 갱신한다. */
export class GameRegistry {
    readonly #options: RegistryOptions;
    readonly #now: () => number;
    readonly #logger: NonNullable<RegistryOptions['logger']>;
    readonly #trackedSeats = new Map<string, Map<ActorId, TrackedSeat>>();
    readonly #pendingReleases = new Map<string, PendingRelease>();
    readonly #kickedByRoom = new Map<string, Set<ActorId>>();
    #lastProjectedRooms = new Set<string>();
    #lastProjectedRoomCodes = new Map<string, string>();
    #healthy = false;
    #timer: NodeJS.Timeout | null = null;
    #publishing: Promise<boolean> | null = null;
    #publishRequested = false;

    public constructor(options: RegistryOptions) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
        this.#logger = options.logger ?? (() => undefined);
    }

    public get healthy(): boolean { return this.#healthy; }

    public async start(): Promise<void> {
        if (this.#timer !== null) return;
        await this.publish();
        this.#timer = setInterval(() => { void this.publish(); }, HEARTBEAT_INTERVAL_MS);
        this.#timer.unref();
    }

    /**
     * Reserve this server id before the command consumer starts.  A live
     * heartbeat is also the ownership record, so a second process must not
     * join the same consumer group.
     */
    public async claimServerId(): Promise<boolean> {
        if (!this.#options.redis.isReady()) return false;
        const heartbeat = this.#heartbeat(this.#now());
        return this.#options.redis.setPxIfAbsent(
            this.#options.keys.gameServer(heartbeat.serverId),
            JSON.stringify(heartbeat),
            HEARTBEAT_TTL_MS,
        );
    }

    /**
     * Publish the first directory change immediately.  Changes while a
     * publish is in flight are folded into exactly one trailing publish.
     */
    /**
     * 이 방은 이제 내 것이 아니다. **지우지 말고 잊는다.**
     *
     * 아래 정리 루프는 "내 방 목록에서 사라진 방"의 디렉터리 키를 지운다. 방이 끝났을 때는
     * 맞는 동작이지만, 다른 서버로 넘긴 방에 그대로 적용하면 **방금 상대가 쓴 키를 지운다.**
     * 그러면 매칭 서버가 그 방을 못 찾아 아무도 재접속하지 못한다 — 실제로 그랬다.
     */
    /**
     * 넘겨받은 방의 사람들이 **여기로** 재접속하게 자리 표를 다시 쓴다.
     *
     * 매칭 서버의 재접속 경로는 방 디렉터리의 serverId와 사용자별 자리 표의 serverId가 **둘 다**
     * 맞는지 본다(`rooms.service.ts`). 방만 옮기고 이걸 안 고치면 전원이 `ROOM_UNAVAILABLE`로
     * 튕겨서, 방은 멀쩡히 여기 있는데 아무도 돌아오지 못한다.
     *
     * `setPx`로 덮어쓴다. 앞 서버가 남긴 표가 아직 살아 있을 수 있고, 그 표는 이미 죽은 서버를
     * 가리키므로 지켜 줄 이유가 없다.
     */
    public async claimAdoptedRoom(roomId: string, userIds: readonly ActorId[]): Promise<void> {
        for (const userId of userIds) {
            await this.#options.redis.setPx(
                this.#options.keys.userActiveRoom(userId),
                JSON.stringify({
                    state: 'assigned',
                    requestId: `adopt:${this.#options.heartbeat.serverId}:${roomId}`,
                    roomId,
                    serverId: this.#options.heartbeat.serverId,
                }),
                ACTIVE_ROOM_TTL_MS,
            );
        }
    }

    public forgetRoom(roomId: string): void {
        this.#lastProjectedRooms.delete(roomId);
        this.#lastProjectedRoomCodes.delete(roomId);
    }

    public requestPublish(): void {
        if (this.#publishing !== null) {
            this.#publishRequested = true;
            return;
        }
        void this.#startPublish();
    }

    public stop(): void {
        if (this.#timer !== null) clearInterval(this.#timer);
        this.#timer = null;
    }

    public trackSeat(roomId: string, userId: ActorId, requestId: string): void {
        const pendingKey = releaseKey(roomId, userId);
        const pending = this.#pendingReleases.get(pendingKey);
        // 다시 살아난 자리의 이전 정리가 새 active-room claim까지 지우면 안 된다.
        if (pending !== undefined && !pending.kicked) this.#pendingReleases.delete(pendingKey);

        let room = this.#trackedSeats.get(roomId);
        if (room === undefined) {
            room = new Map();
            this.#trackedSeats.set(roomId, room);
        }
        if (!room.has(userId)) room.set(userId, { joined: false, requestId });
    }

    /** RELEASE_SEAT와 로컬 departure 감지가 같은 정리 큐를 쓴다. */
    public noteReleased(roomId: string, userId: ActorId, cooldown: boolean): void {
        const kicked = this.#kickedByRoom.get(roomId)?.has(userId) ?? false;
        const key = releaseKey(roomId, userId);
        const previous = this.#pendingReleases.get(key);
        this.#pendingReleases.set(key, {
            roomId,
            userId,
            cooldown: cooldown || (previous?.cooldown ?? false),
            kicked: kicked || (previous?.kicked ?? false),
            releasedAt: previous?.releasedAt ?? this.#now(),
        });
        this.#trackedSeats.get(roomId)?.delete(userId);
    }

    public noteKicked(roomId: string, userId: ActorId): void {
        let users = this.#kickedByRoom.get(roomId);
        if (users === undefined) {
            users = new Set();
            this.#kickedByRoom.set(roomId, users);
        }
        users.add(userId);
        const pending = this.#pendingReleases.get(releaseKey(roomId, userId));
        if (pending !== undefined && !pending.kicked) {
            this.#pendingReleases.set(releaseKey(roomId, userId), { ...pending, kicked: true });
        }
    }

    /** 장애 시 false를 반환한다. 로컬 rooms나 추적 정보는 버리지 않는다. */
    public publish(): Promise<boolean> {
        if (this.#publishing !== null) return this.#publishing;
        return this.#startPublish();
    }

    #startPublish(): Promise<boolean> {
        const publishing = this.#publishOnce().finally(() => {
            this.#publishing = null;
            if (this.#publishRequested) {
                this.#publishRequested = false;
                void this.#startPublish();
            }
        });
        this.#publishing = publishing;
        return publishing;
    }

    async #publishOnce(): Promise<boolean> {
        if (!this.#options.redis.isReady()) {
            this.#healthy = false;
            return false;
        }
        const now = this.#now();
        try {
            await this.#flushPendingReleases();
            await this.#synchronizeTrackedSeats();

            const heartbeat = this.#heartbeat(now);
            await this.#options.redis.setPx(
                this.#options.keys.gameServer(heartbeat.serverId),
                JSON.stringify(heartbeat),
                HEARTBEAT_TTL_MS,
            );
            await this.#options.redis.zAdd(this.#options.keys.gameServersAlive(), now, heartbeat.serverId);
            await this.#options.redis.zRemoveByScore(
                this.#options.keys.gameServersAlive(),
                Number.NEGATIVE_INFINITY,
                now - HEARTBEAT_TTL_MS,
            );

            const projections = this.#options.rooms.projections().filter(
                (projection) => projection.state !== RoomState.Allocating && projection.state !== RoomState.Closed,
            );
            const currentRoomIds = new Set<string>();
            for (const projection of projections) {
                currentRoomIds.add(projection.roomId);
                await this.#publishRoom(projection, now);
            }
            for (const oldRoomId of this.#lastProjectedRooms) {
                if (currentRoomIds.has(oldRoomId)) continue;
                await this.#options.redis.delete(this.#options.keys.room(oldRoomId));
                const oldCode = this.#lastProjectedRoomCodes.get(oldRoomId);
                if (oldCode) await this.#options.redis.delete(this.#options.keys.roomCode(oldCode));
                await this.#options.redis.zRemove(this.#options.keys.roomsWaiting(), oldRoomId);
            }
            await this.#options.redis.zRemoveByScore(
                this.#options.keys.roomsWaiting(),
                Number.NEGATIVE_INFINITY,
                now - HEARTBEAT_TTL_MS,
            );
            await this.#publishKickMarkers();
            this.#lastProjectedRooms = currentRoomIds;
            this.#lastProjectedRoomCodes = new Map(projections.map((projection) => [projection.roomId, projection.roomCode]));
            this.#healthy = true;
            return true;
        } catch (error: unknown) {
            this.#healthy = false;
            this.#logger('Redis registry heartbeat failed; local rooms remain active', error);
            return false;
        }
    }

    #heartbeat(now: number): GameServerHeartbeat {
        const counts = this.#options.rooms.counts();
        return {
            serverId: this.#options.heartbeat.serverId,
            buildVersion: this.#options.heartbeat.buildVersion,
            protocolVersion: this.#options.heartbeat.protocolVersion,
            rulesVersion: this.#options.heartbeat.rulesVersion,
            mapBundleHash: this.#options.heartbeat.mapBundleHash,
            waitingRooms: counts.waiting,
            playingRooms: counts.playing,
            connections: this.#options.heartbeat.connectionCount(),
            loopLagMs: this.#options.heartbeat.loopLagMs(),
            draining: this.#options.heartbeat.isDraining(),
            internalAddress: this.#options.heartbeat.internalAddress(),
            maxRooms: this.#options.heartbeat.maxRooms,
            updatedAt: now,
        };
    }

    async #publishRoom(projection: RoomProjection, now: number): Promise<void> {
        const value: RoomDirectoryValue = {
            ...projection,
            serverId: this.#options.heartbeat.serverId,
            status: projection.state,
            updatedAt: now,
        };
        await this.#options.redis.setPx(this.#options.keys.room(projection.roomId), JSON.stringify(value), HEARTBEAT_TTL_MS);
        await this.#options.redis.setPx(this.#options.keys.roomCode(projection.roomCode), projection.roomId, HEARTBEAT_TTL_MS);
        // 훈련장은 혼자 들어가는 방이라 목록에도 빠른 참가에도 나오면 안 된다.
        // 코드로도 못 들어오게 하려면 roomCode 자체를 안 실어야 하지만, 그건 방을 만든
        // 본인의 재접속(resume) 경로까지 막는다. 목록에서 빼는 선에서 멈춘다.
        if (projection.mode !== RoomMode.Training && projection.state === RoomState.Waiting && !projection.locked) {
            await this.#options.redis.zAdd(this.#options.keys.roomsWaiting(), now, projection.roomId);
        } else {
            await this.#options.redis.zRemove(this.#options.keys.roomsWaiting(), projection.roomId);
        }
    }

    async #synchronizeTrackedSeats(): Promise<void> {
        for (const [roomId, users] of this.#trackedSeats) {
            const room = this.#options.rooms.get(roomId);
            for (const [userId, tracked] of users) {
                const member = room?.memberByUser(userId) ?? null;
                if (member !== null) tracked.joined = true;
                if (room !== null && room.hasUser(userId)) {
                    const activeKey = this.#options.keys.userActiveRoom(userId);
                    const currentClaim = await this.#options.redis.get(activeKey);
                    const refreshed = currentClaim !== null
                        && this.#claimBelongsToSeat(currentClaim, roomId, tracked.requestId)
                        && await this.#options.redis.compareAndExpire(activeKey, currentClaim, ACTIVE_ROOM_TTL_MS);
                    if (!refreshed && tracked.joined) {
                        await this.#options.redis.setPxIfAbsent(activeKey, JSON.stringify({
                            state: 'assigned',
                            requestId: `heartbeat:${this.#options.heartbeat.serverId}:${roomId}`,
                            roomId,
                            serverId: this.#options.heartbeat.serverId,
                        }), ACTIVE_ROOM_TTL_MS);
                    }
                    continue;
                }

                const kicked = room?.isKicked(userId) ?? false;
                if (kicked) this.noteKicked(roomId, userId);
                this.#pendingReleases.set(releaseKey(roomId, userId), {
                    roomId,
                    userId,
                    cooldown: room !== null && tracked.joined,
                    kicked,
                    releasedAt: this.#now(),
                });
                users.delete(userId);
            }
            if (users.size === 0) this.#trackedSeats.delete(roomId);
        }
        await this.#flushPendingReleases();
    }

    async #flushPendingReleases(): Promise<void> {
        for (const [key, release] of this.#pendingReleases) {
            const room = this.#options.rooms.get(release.roomId);
            // Redis 대기 사이 명단에 돌아온 자리에 낡은 해제를 적용하면 재접속을 다시 막는다.
            if (!release.kicked && room !== null && room.hasUser(release.userId)) {
                this.#pendingReleases.delete(key);
                continue;
            }
            if (release.cooldown) {
                const remainingMs = REJOIN_COOLDOWN_MS - (this.#now() - release.releasedAt);
                if (remainingMs > 0) {
                    await this.#options.redis.setPx(
                        this.#options.keys.roomRejoin(release.roomId, release.userId),
                        '1',
                        remainingMs,
                    );
                }
            }
            if (release.kicked) {
                await this.#options.redis.setPx(
                    this.#options.keys.operation(`${KICK_MARKER_PREFIX}:${release.roomId}:${release.userId}`),
                    '1',
                    HEARTBEAT_TTL_MS,
                );
            }
            await this.#deleteMatchingActiveRoom(release.roomId, release.userId);
            this.#pendingReleases.delete(key);
        }
    }

    #claimBelongsToSeat(raw: string, roomId: string, requestId: string): boolean {
        try {
            const claim = JSON.parse(raw) as unknown;
            if (claim === null || typeof claim !== 'object') return false;
            const value = claim as Record<string, unknown>;
            if (value['state'] === 'reservation') return value['requestId'] === requestId;
            return value['state'] === 'assigned'
                && value['roomId'] === roomId
                && value['serverId'] === this.#options.heartbeat.serverId;
        } catch {
            return false;
        }
    }

    async #deleteMatchingActiveRoom(roomId: string, userId: ActorId): Promise<void> {
        const key = this.#options.keys.userActiveRoom(userId);
        const raw = await this.#options.redis.get(key);
        if (raw === null) return;
        let assignedRoomId: unknown;
        try {
            const parsed = JSON.parse(raw) as unknown;
            assignedRoomId = parsed !== null && typeof parsed === 'object'
                ? (parsed as Record<string, unknown>)['roomId']
                : undefined;
        } catch {
            return;
        }
        // reservation 단계에는 roomId가 없고, 다른 방의 새 claim일 수도 있으므로 건드리지 않는다.
        if (assignedRoomId === roomId) await this.#options.redis.compareAndDelete(key, raw);
    }

    async #publishKickMarkers(): Promise<void> {
        for (const [roomId, users] of this.#kickedByRoom) {
            if (this.#options.rooms.get(roomId) === null) {
                this.#kickedByRoom.delete(roomId);
                continue;
            }
            for (const userId of users) {
                await this.#options.redis.setPx(
                    this.#options.keys.operation(`${KICK_MARKER_PREFIX}:${roomId}:${userId}`),
                    '1',
                    HEARTBEAT_TTL_MS,
                );
            }
        }
    }
}
