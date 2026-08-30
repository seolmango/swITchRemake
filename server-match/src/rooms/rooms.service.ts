import {
    ConflictException,
    ForbiddenException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
    ServiceUnavailableException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { randomInt, randomUUID } from 'node:crypto';
import {
    CommandType,
    ConsumerGroup,
    CONTROL_VERSION,
    ControlErrorCode,
    MAX_PLAYERS_PER_ROOM,
    RoomMode,
    PROTOCOL_VERSION,
    makeKeys,
    type ActorId,
    type ControlCommand,
    type ControlReply,
    type CreateRoomResult,
    type DeleteReplayPayload,
    type GameServerHeartbeat,
    type LobbyStats,
    type SeatGrant,
} from 'shared';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';
import { RedisService } from '../redis/redis.service';
import { SanctionService } from '../sanction/sanction.service';
import { CONTROL_STREAM_FIELDS, decodeReply, encodeCommand } from './control-stream.codec';
import { CreateRoomDto } from './dto/create-room.dto';
import { ResultService } from '../results/result.service';
import { SessionSecurityService } from '../session/session-security.service';
import { lobbyStatsFrom } from '../user/stored-stats';

const COMMAND_RETRY_INTERVAL_MS = 2_000;
const COMMAND_DEADLINE_MS = 6_000;
const ACTIVE_ROOM_RESERVATION_TTL_SECONDS = 30;
// A shared NAT can have ten guests create/join or retry a room request within a minute.
const JOIN_RATE_LIMIT = 30;
const JOIN_RATE_WINDOW_SECONDS = 60;
const REJOIN_COOLDOWN_SECONDS = 60;
const ROOM_LIST_PAGE_SIZE = 20;
/**
 * 자기 전용 응답 stream을 살려 두는 시간. 읽기 루프가 한 바퀴(최대 1초)마다 갱신한다.
 * 프로세스가 죽으면 갱신이 멈추고 키가 사라진다 — 죽은 인스턴스의 stream이 Redis에 남지 않는다.
 */
const REPLY_STREAM_TTL_SECONDS = 300;
/** 인게임 서버의 명령 stream 수명. 읽는 쪽과 같은 값이어야 한다(server-game의 COMMAND_STREAM_TTL_MS). */
const COMMAND_STREAM_TTL_SECONDS = 300;

interface Actor {
    id: ActorId;
    nickname: string;
    guest: boolean;
    /**
     * 로비 카드에 띄울 전적. 게스트는 null이다.
     *
     * `requireActor`가 어차피 읽는 사용자 행에 딸려 온다. 자리를 예약할 때 인게임 서버로 실어
     * 보내기 위한 값이다 — 인게임 서버는 DB를 모르므로 스스로 채울 수 없다.
     */
    stats: LobbyStats | null;
}

export interface RoomPrincipal {
    id: ActorId;
    nickname?: string;
    guest?: boolean;
}

interface ActiveRoomClaim {
    state: 'reservation' | 'assigned';
    requestId: string;
    roomId?: string;
    serverId?: string;
}

interface RoomDirectoryEntry {
    roomId?: string;
    id?: string;
    serverId: string;
    name?: string;
    roomName?: string;
    roomCode?: string;
    ownerName?: string;
    playerCount?: number;
    capacity?: number;
    hasPassword?: boolean;
    status?: string;
}

interface PendingReply {
    expectedServerId: string;
    resolve: (reply: ControlReply) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
}

type ClientSeatGrant = SeatGrant & { roomId: string; roomCode: string };

/**
 * 이 서버가 방을 더 받을 수 있는가.
 *
 * `maxRooms`를 안 싣던 시절의 heartbeat도 있을 수 있다. 그때는 상한이 없는 것으로 본다 —
 * 모르는 값 때문에 멀쩡한 서버를 후보에서 빼면 배정이 통째로 막힌다.
 */
const hasRoomCapacity = (server: GameServerHeartbeat): boolean =>
    typeof server.maxRooms !== 'number' || server.waitingRooms + server.playingRooms < server.maxRooms;

@Injectable()
export class RoomsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RoomsService.name);
    private readonly keys: ReturnType<typeof makeKeys>;
    private readonly consumer = `matching-${randomUUID()}`;
    /**
     * 이 인스턴스만 읽는 응답 stream.
     *
     * 예전에는 모든 인스턴스가 공용 stream 하나를 같은 소비자 그룹으로 읽었다. 소비자 그룹은 항목을
     * 나눠 주므로 남의 응답을 받아 ack해 버렸고, 원 요청자는 2초 복구 타이머까지 기다렸다.
     */
    private readonly replyStream: string;
    private readonly pending = new Map<string, PendingReply>();
    private stopping = false;
    private replyFailureBackoffMs = 50;

    constructor(
        @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
        private readonly redis: RedisService,
        private readonly sanctions: SanctionService,
        private readonly results: ResultService,
        private readonly sessionSecurity: SessionSecurityService,
    ) {
        const environment = process.env.APP_ENV ?? 'dev';
        this.keys = makeKeys(environment);
        this.replyStream = this.keys.repliesFor(this.consumer);
    }

    async onModuleInit(): Promise<void> {
        await this.redis.ensureConsumerGroup(this.replyStream, ConsumerGroup.Replies);
        await this.redis.expire(this.replyStream, REPLY_STREAM_TTL_SECONDS);
        void this.consumeReplies();
    }

    onModuleDestroy(): void {
        this.stopping = true;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Matching server stopped'));
        }
        this.pending.clear();
    }

    /** 인게임 서버의 응답을 기다리고 있는 제어 명령 수. 운영자 화면이 밀림을 읽는 값이다. */
    pendingCommandCount(): number {
        return this.pending.size;
    }

    async requestReplayDeletion(serverId: string, payload: DeleteReplayPayload): Promise<boolean> {
        const issuedAt = Date.now();
        try {
            const reply = await this.sendCommand<Record<string, never>>(serverId, {
                v: CONTROL_VERSION,
                requestId: randomUUID(),
                type: CommandType.DeleteReplay,
                issuedAt,
                deadlineAt: issuedAt + COMMAND_DEADLINE_MS,
                replyTo: this.replyStream,
                payload,
            });
            return reply.ok;
        } catch {
            // 정리 회차가 끊기면 뒤의 파일도 재시도하지 못한다. 실패한 행만 deleting으로 남긴다.
            return false;
        }
    }

    /**
     * 방 목록 한 쪽.
     *
     * **Redis에서 그 쪽만 읽는다.** 예전에는 대기 중인 방을 전부 읽어 요약한 뒤 20개로 잘랐다.
     * 방이 500개면 목록 한 번에 방 GET 500번 + 서버 heartbeat GET 500번이었고, 그건 사람이
     * 가장 자주 누르는 화면이다.
     *
     * 그래서 `total`은 집합의 크기다 - 방금 죽은 서버의 방이 잠깐 섞여 실제 표시 수보다 클 수
     * 있다. 등록부가 heartbeat TTL(6초)마다 그런 항목을 걷어내므로 잠깐이고, 정확한 수를 위해
     * 매번 전부 읽는 값보다 이쪽이 싸다.
     */
    async list(page = 1) {
        const safePage = Number.isInteger(page) && page > 0 ? page : 1;
        const total = await this.redis.sortedSetSize(this.keys.roomsWaiting());
        const totalPages = Math.max(1, Math.ceil(total / ROOM_LIST_PAGE_SIZE));
        const currentPage = Math.min(safePage, totalPages);
        const offset = (currentPage - 1) * ROOM_LIST_PAGE_SIZE;
        const ids = await this.redis.sortedSetMembers(
            this.keys.roomsWaiting(),
            offset,
            offset + ROOM_LIST_PAGE_SIZE - 1,
        );
        // 한 쪽의 방은 대부분 같은 서버에 몰려 있다. heartbeat를 방마다 다시 읽을 이유가 없다.
        const servers = new Map<string, GameServerHeartbeat | null>();
        const rooms = (await Promise.all(ids.map((id) => this.readLiveRoom(id, servers))))
            .filter((room): room is RoomDirectoryEntry => room !== null)
            .map((room) => this.toSummary(room));
        return { rooms, page: currentPage, totalPages, total };
    }

    async create(principal: ActorId | RoomPrincipal, dto: CreateRoomDto, clientIp?: string) {
        const actor = await this.requireActor(principal);
        await this.enforceActorRate(actor.id, 'room-create-rate');
        await this.enforceGuestIpRate(actor, clientIp, 'room-create-rate');
        const training = dto.mode === RoomMode.Training;
        const roomName = this.cleanRoomName(dto.name);
        const requestId = randomUUID();
        const claim = await this.claimActiveRoom(actor.id, requestId);
        if (!claim) {
            return this.existingRoomResponse(actor.id);
        }

        let issuedMatchId: string | null = null;
        let roomCodeReservation: { code: string; value: string } | null = null;
        try {
            const server = await this.selectServer();
            roomCodeReservation = await this.reserveRoomCode(requestId);
            issuedMatchId = randomUUID();
            await this.results.issueMatch(issuedMatchId, server.serverId, dto.mapId ?? 'random', actor);
            const reply = await this.sendCommand<CreateRoomResult>(server.serverId, {
                v: CONTROL_VERSION,
                requestId,
                type: CommandType.CreateRoom,
                issuedAt: Date.now(),
                deadlineAt: Date.now() + COMMAND_DEADLINE_MS,
                replyTo: this.replyStream,
                payload: {
                    matchId: issuedMatchId,
                    roomCode: roomCodeReservation.code,
                    roomName,
                    password: dto.password?.length ? dto.password : null,
                    ownerUserId: actor.id,
                    ownerNickname: actor.nickname,
                    ownerStats: actor.stats,
                    capacity: dto.capacity ?? (training ? 1 : MAX_PLAYERS_PER_ROOM),
                    mapId: dto.mapId ?? 'random',
                    ...(training ? { mode: RoomMode.Training } : {}),
                },
            });
            if (!reply.ok || !reply.payload) {
                await this.redis.compareAndDelete(this.keys.userActiveRoom(actor.id), claim);
                await this.results.discardIssuedMatch(issuedMatchId);
                issuedMatchId = null;
                this.throwControlError(reply.code);
            }

            await this.results.confirmRoom(issuedMatchId, reply.payload.roomId, reply.payload.mapId);
            await this.redis.set(this.keys.roomCode(reply.payload.roomCode), reply.payload.roomId, ACTIVE_ROOM_RESERVATION_TTL_SECONDS);
            await this.assignActiveRoom(actor.id, claim, requestId, reply.serverId, reply.payload.roomId);
            return reply.payload;
        } catch (error) {
            await this.redis.compareAndDelete(this.keys.userActiveRoom(actor.id), claim);
            if (issuedMatchId) await this.results.discardIssuedMatch(issuedMatchId).catch(() => undefined);
            if (roomCodeReservation) {
                await this.redis.compareAndDelete(this.keys.roomCode(roomCodeReservation.code), roomCodeReservation.value);
            }
            throw error;
        }
    }

    async join(principal: ActorId | RoomPrincipal, roomId: string, password?: string, clientIp?: string): Promise<ClientSeatGrant | { alreadyAssigned: true; roomId?: string }> {
        const actor = await this.requireActor(principal);
        await this.enforceJoinAbuseLimits(actor, roomId, clientIp);
        const room = await this.readLiveRoom(roomId);
        if (!room) {
            this.throwMaskedRoomError();
        }

        const requestId = randomUUID();
        const claim = await this.claimActiveRoom(actor.id, requestId);
        if (!claim) {
            return this.existingRoomResponse(actor.id);
        }

        let assignedMatchId: string | null = null;
        try {
            assignedMatchId = await this.results.addAssignmentByRoom(roomId, actor);
            if (!assignedMatchId) {
                throw new ServiceUnavailableException({ code: 'MATCH_ASSIGNMENT_UNAVAILABLE', retryable: true });
            }
            const reply = await this.sendCommand<SeatGrant>(room.serverId, {
                v: CONTROL_VERSION,
                requestId,
                type: CommandType.ReserveJoin,
                issuedAt: Date.now(),
                deadlineAt: Date.now() + COMMAND_DEADLINE_MS,
                replyTo: this.replyStream,
                payload: {
                    roomId,
                    userId: actor.id,
                    nickname: actor.nickname,
                    stats: actor.stats,
                    password: password?.length ? password : null,
                },
            });
            if (!reply.ok || !reply.payload) {
                await this.redis.compareAndDelete(this.keys.userActiveRoom(actor.id), claim);
                await this.results.removeAssignment(assignedMatchId, actor.id);
                assignedMatchId = null;
                this.throwControlError(reply.code);
            }
            await this.assignActiveRoom(actor.id, claim, requestId, reply.serverId, roomId);
            return { roomId, roomCode: room.roomCode ?? '', ...reply.payload };
        } catch (error) {
            await this.redis.compareAndDelete(this.keys.userActiveRoom(actor.id), claim);
            if (assignedMatchId) await this.results.removeAssignment(assignedMatchId, actor.id).catch(() => undefined);
            throw error;
        }
    }

    async joinByCode(principal: ActorId | RoomPrincipal, roomCode: string, password?: string, clientIp?: string) {
        const normalized = roomCode.trim().toUpperCase();
        if (!/^[A-HJ-NP-Z2-9]{6}$/.test(normalized)) this.throwMaskedRoomError();
        const roomId = await this.redis.get(this.keys.roomCode(normalized));
        if (!roomId || !/^[0-9a-f-]{36}$/i.test(roomId)) this.throwMaskedRoomError();
        return this.join(principal, roomId, password, clientIp);
    }

    async quickJoin(principal: ActorId | RoomPrincipal, clientIp?: string): Promise<ClientSeatGrant | { alreadyAssigned: true; roomId?: string }> {
        const actor = await this.requireActor(principal);
        await this.enforceActorRate(actor.id, 'room-join-rate');
        await this.enforceGuestIpRate(actor, clientIp, 'room-join-rate');
        const candidates = (await this.redis.sortedSetMembers(this.keys.roomsWaiting(), 0, -1))
            .map((roomId) => ({ roomId, sort: Math.random() }))
            .sort((a, b) => a.sort - b.sort);
        const requestId = randomUUID();
        const claim = await this.claimActiveRoom(actor.id, requestId);
        if (!claim) {
            return this.existingRoomResponse(actor.id);
        }

        let pendingAssignment: string | null = null;
        try {
            for (const candidate of candidates) {
                const room = await this.readLiveRoom(candidate.roomId);
                if (!room || room.hasPassword || !this.hasVacancy(room)) {
                    continue;
                }
                if (await this.isJoinBlocked(actor.id, candidate.roomId)) {
                    continue;
                }
                const assignedMatchId = await this.results.addAssignmentByRoom(candidate.roomId, actor);
                if (!assignedMatchId) continue;
                pendingAssignment = assignedMatchId;
                const reply = await this.sendCommand<SeatGrant>(room.serverId, {
                    v: CONTROL_VERSION,
                    requestId: randomUUID(),
                    type: CommandType.ReserveJoin,
                    issuedAt: Date.now(),
                    deadlineAt: Date.now() + COMMAND_DEADLINE_MS,
                    replyTo: this.replyStream,
                    payload: {
                        roomId: candidate.roomId,
                        userId: actor.id,
                        nickname: actor.nickname,
                        stats: actor.stats,
                        password: null,
                    },
                });
                if (reply.ok && reply.payload) {
                    await this.assignActiveRoom(actor.id, claim, requestId, reply.serverId, candidate.roomId);
                    pendingAssignment = null;
                    return { roomId: candidate.roomId, roomCode: room.roomCode ?? '', ...reply.payload };
                }
                await this.results.removeAssignment(assignedMatchId, actor.id);
                pendingAssignment = null;
                if (reply.code === ControlErrorCode.RoomNotFound || reply.code === ControlErrorCode.BadPassword) {
                    continue;
                }
            }
            await this.redis.compareAndDelete(this.keys.userActiveRoom(actor.id), claim);
            throw new ConflictException({ code: 'NO_JOINABLE_ROOM', message: 'No joinable room is available' });
        } catch (error) {
            if (pendingAssignment) await this.results.removeAssignment(pendingAssignment, actor.id).catch(() => undefined);
            await this.redis.compareAndDelete(this.keys.userActiveRoom(actor.id), claim);
            throw error;
        }
    }

    async resume(principal: ActorId | RoomPrincipal, roomId: string): Promise<ClientSeatGrant> {
        const actor = await this.requireActor(principal);
        const activeKey = this.keys.userActiveRoom(actor.id);
        const rawClaim = await this.redis.get(activeKey);
        if (!rawClaim) {
            throw new ConflictException({ code: 'NO_ACTIVE_ROOM', message: 'No active room assignment exists' });
        }
        let claim: ActiveRoomClaim;
        try {
            claim = JSON.parse(rawClaim) as ActiveRoomClaim;
        } catch {
            throw new ConflictException({ code: 'NO_ACTIVE_ROOM', message: 'No active room assignment exists' });
        }
        if (claim.state !== 'assigned' || claim.roomId !== roomId) {
            throw new ConflictException({ code: 'ACTIVE_ROOM_MISMATCH', message: 'Room does not match the active assignment' });
        }

        const room = await this.readLiveRoom(roomId);
        if (!room || room.serverId !== claim.serverId) {
            throw new ConflictException({ code: 'ROOM_UNAVAILABLE', message: 'Room is no longer available' });
        }
        const reply = await this.sendCommand<SeatGrant>(room.serverId, {
            v: CONTROL_VERSION,
            requestId: randomUUID(),
            type: CommandType.ReserveResume,
            issuedAt: Date.now(),
            deadlineAt: Date.now() + COMMAND_DEADLINE_MS,
            replyTo: this.replyStream,
            payload: { roomId, userId: actor.id },
        });
        if (!reply.ok || !reply.payload) {
            this.throwControlError(reply.code);
        }
        await this.redis.compareAndSetWithTtl(
            activeKey,
            rawClaim,
            rawClaim,
            ACTIVE_ROOM_RESERVATION_TTL_SECONDS,
        );
        return { roomId, roomCode: room.roomCode ?? '', ...reply.payload };
    }

    /**
     * 이 사람을 지금 있는 방에서 내보낸다.
     *
     * 제재는 세션 행만 지웠다. 이미 발급된 access token은 만료까지 살아 있고 인게임 서버는
     * 계정 상태를 아예 모르므로, 밴당한 사람이 그 경기가 끝날 때까지 그대로 놀았다. KICK_USER
     * 명령은 인게임 서버에 처음부터 구현돼 있었는데 보내는 사람이 없었다.
     *
     * 실패해도 던지지 않는다. 제재는 이미 커밋됐고, 퇴장에 실패했다고 되돌릴 수 있는 것이 아니다.
     * 못 내보낸 사람도 다음 방 배정에서는 `requireActor`가 막는다.
     */
    async evictActor(userId: ActorId, reason: string): Promise<boolean> {
        let raw: string | null = null;
        try {
            raw = await this.redis.get(this.keys.userActiveRoom(userId));
        } catch {
            return false;
        }
        if (!raw) return false;

        let claim: ActiveRoomClaim;
        try {
            claim = JSON.parse(raw) as ActiveRoomClaim;
        } catch {
            return false;
        }
        if (claim.state !== 'assigned' || !claim.roomId || !claim.serverId) return false;

        const issuedAt = Date.now();
        try {
            const reply = await this.sendCommand<Record<string, never>>(claim.serverId, {
                v: CONTROL_VERSION,
                requestId: randomUUID(),
                type: CommandType.KickUser,
                issuedAt,
                deadlineAt: issuedAt + COMMAND_DEADLINE_MS,
                replyTo: this.replyStream,
                payload: { roomId: claim.roomId, userId, reason: reason.slice(0, 256) },
            });
            return reply.ok;
        } catch (error) {
            this.logger.warn(`제재 대상을 방에서 내보내지 못했다 userId=${String(userId)} roomId=${claim.roomId}`);
            return false;
        }
    }

    /** Called by the result/room-event bridge when a confirmed departure arrives. */
    async markRejoinCooldown(roomId: string, userId: ActorId): Promise<void> {
        await this.redis.set(this.keys.roomRejoin(roomId, userId), '1', REJOIN_COOLDOWN_SECONDS);
    }

    private async requireActor(principal: ActorId | RoomPrincipal): Promise<Actor> {
        const identity = typeof principal === 'object' ? principal : { id: principal };
        if (typeof identity.id === 'string') {
            if (!identity.guest
                || !/^g:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.id)
                || typeof identity.nickname !== 'string'
                || !/^Guest_[A-HJ-NP-Z2-9]{6}$/.test(identity.nickname)) {
                throw new ForbiddenException('Guest identity is invalid');
            }
            return { id: identity.id, nickname: identity.nickname, guest: true, stats: null };
        }
        const userId = identity.id;
        const [user] = await this.db.select({
            id: schema.users.id,
            nickname: schema.users.nickname,
            accountStatus: schema.users.accountStatus,
            stats: schema.users.stats,
        }).from(schema.users).where(eq(schema.users.id, userId));
        if (!user) {
            throw new ForbiddenException('Account is not active');
        }
        const status = await this.sanctions.reconcileLoginStatus(user.id, user.accountStatus);
        if (status !== 'ACTIVE') {
            throw new ForbiddenException('Account is not active');
        }
        // 경기 제한은 로그인은 두고 방만 막는 처분이다. 방으로 들어오는 길이 전부 여기를
        // 지나므로 판정도 여기 한 곳에 둔다.
        if (await this.sanctions.isGameRestricted(user.id)) {
            throw new ForbiddenException({
                code: 'GAME_RESTRICTED',
                message: 'This account is restricted from playing',
            });
        }
        return { id: user.id, nickname: user.nickname, guest: false, stats: lobbyStatsFrom(user.stats) };
    }

    private async enforceJoinAbuseLimits(actor: Actor, roomId: string, clientIp?: string): Promise<void> {
        await this.enforceActorRate(actor.id, 'room-join-rate');
        await this.enforceGuestIpRate(actor, clientIp, 'room-join-rate');
        const blocked = await this.isJoinBlocked(actor.id, roomId);
        if (blocked?.kind === 'kicked') {
            throw new ForbiddenException({ code: ControlErrorCode.KickedFromRoom, message: 'You were removed from this room' });
        }
        if (blocked?.kind === 'cooldown') {
            throw new ConflictException({
                code: ControlErrorCode.RejoinCooldown,
                retryAfterMs: blocked.retryAfterMs,
                message: 'Please wait before joining this room again',
            });
        }
    }

    private async isJoinBlocked(
        userId: ActorId,
        roomId: string,
    ): Promise<{ kind: 'kicked' } | { kind: 'cooldown'; retryAfterMs: number } | null> {
        const [cooldown, kicked] = await Promise.all([
            this.redis.ttlMilliseconds(this.keys.roomRejoin(roomId, userId)),
            this.redis.get(this.keys.operation(`room-kicked:${roomId}:${userId}`)),
        ]);
        if (kicked) {
            return { kind: 'kicked' };
        }
        if (cooldown > 0) {
            return { kind: 'cooldown', retryAfterMs: cooldown };
        }
        return null;
    }

    private async enforceActorRate(userId: ActorId, bucket: string): Promise<void> {
        const count = await this.redis.incrementWithTtl(
            this.keys.operation(`${bucket}:actor:${userId}`),
            JOIN_RATE_WINDOW_SECONDS,
        );
        if (count > JOIN_RATE_LIMIT) {
            const retryAfterMs = await this.redis.ttlMilliseconds(this.keys.operation(`${bucket}:actor:${userId}`));
            throw new HttpException({
                code: 'JOIN_RATE_LIMITED',
                retryAfterMs: Math.max(0, retryAfterMs),
                message: 'Too many room join requests',
            }, HttpStatus.TOO_MANY_REQUESTS);
        }
    }

    private async enforceGuestIpRate(actor: Actor, clientIp: string | undefined, bucket: string): Promise<void> {
        if (!actor.guest) return;
        if (!clientIp) throw new ForbiddenException('Client IP is required for guest requests');
        const ipKey = this.sessionSecurity.hmacIp(clientIp);
        const count = await this.redis.incrementWithTtl(
            this.keys.operation(`${bucket}:ip:${ipKey}`),
            JOIN_RATE_WINDOW_SECONDS,
        );
        if (count > JOIN_RATE_LIMIT) {
            const retryAfterMs = await this.redis.ttlMilliseconds(this.keys.operation(`${bucket}:ip:${ipKey}`));
            throw new HttpException({
                code: 'JOIN_RATE_LIMITED',
                retryAfterMs: Math.max(0, retryAfterMs),
                message: 'Too many room requests from this IP',
            }, HttpStatus.TOO_MANY_REQUESTS);
        }
    }

    private async claimActiveRoom(userId: ActorId, requestId: string): Promise<string | null> {
        const claim = JSON.stringify({ state: 'reservation', requestId } satisfies ActiveRoomClaim);
        return (await this.redis.setIfAbsent(
            this.keys.userActiveRoom(userId),
            claim,
            ACTIVE_ROOM_RESERVATION_TTL_SECONDS,
        )) ? claim : null;
    }

    private async reserveRoomCode(requestId: string): Promise<{ code: string; value: string }> {
        const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        const value = `reservation:${requestId}`;
        for (let attempt = 0; attempt < 12; attempt += 1) {
            const code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
            if (await this.redis.setIfAbsent(this.keys.roomCode(code), value, ACTIVE_ROOM_RESERVATION_TTL_SECONDS)) {
                return { code, value };
            }
        }
        throw new ServiceUnavailableException({ code: 'ROOM_CODE_EXHAUSTED', retryable: true });
    }

    private async existingRoomResponse(userId: ActorId): Promise<{ alreadyAssigned: true; roomId?: string }> {
        const raw = await this.redis.get(this.keys.userActiveRoom(userId));
        if (!raw) {
            // A just-expired reservation raced this request. The caller may retry.
            throw new ServiceUnavailableException({ code: 'ACTIVE_ROOM_RACE', retryable: true });
        }
        try {
            const claim = JSON.parse(raw) as ActiveRoomClaim;
            if (claim.state === 'assigned' && claim.roomId) {
                return { alreadyAssigned: true, roomId: claim.roomId };
            }
            throw new ServiceUnavailableException({ code: 'ACTIVE_ROOM_PENDING', retryable: true });
        } catch {
            throw new ServiceUnavailableException({ code: 'ACTIVE_ROOM_PENDING', retryable: true });
        }
    }

    private async assignActiveRoom(
        userId: ActorId,
        expectedClaim: string,
        requestId: string,
        serverId: string,
        roomId: string,
    ): Promise<void> {
        const assigned = JSON.stringify({ state: 'assigned', requestId, roomId, serverId } satisfies ActiveRoomClaim);
        const updated = await this.redis.compareAndSetWithTtl(
            this.keys.userActiveRoom(userId),
            expectedClaim,
            assigned,
            ACTIVE_ROOM_RESERVATION_TTL_SECONDS,
        );
        if (!updated) {
            throw new ServiceUnavailableException({ code: 'ACTIVE_ROOM_CLAIM_LOST', retryable: true });
        }
    }

    private async selectServer(): Promise<GameServerHeartbeat> {
        const ids = await this.redis.sortedSetMembers(this.keys.gameServersAlive(), 0, -1);
        const candidates = (await Promise.all(ids.map((id) => this.readServer(id))))
            .filter((server): server is GameServerHeartbeat => server !== null)
            .filter((server) => !server.draining && server.protocolVersion === PROTOCOL_VERSION)
            // 가득 찬 서버는 아예 후보에서 뺀다. 넣어 두면 가장 한가한 축에 들 때 골라 놓고
            // SERVER_FULL을 돌려받는다 — 사용자에게는 그냥 실패다.
            .filter((server) => hasRoomCapacity(server));
        if (!candidates.length) {
            throw new ServiceUnavailableException({ code: 'NO_GAME_SERVER', retryable: true });
        }
        candidates.sort((a, b) => this.serverLoad(a) - this.serverLoad(b) || a.serverId.localeCompare(b.serverId));
        return candidates[0];
    }

    private serverLoad(server: GameServerHeartbeat): number {
        return server.waitingRooms + server.playingRooms + server.connections / MAX_PLAYERS_PER_ROOM + server.loopLagMs / 1000;
    }

    private async readServer(
        serverId: string,
        cache?: Map<string, GameServerHeartbeat | null>,
    ): Promise<GameServerHeartbeat | null> {
        const cached = cache?.get(serverId);
        if (cached !== undefined) return cached;
        const server = await this.#readServerUncached(serverId);
        cache?.set(serverId, server);
        return server;
    }

    async #readServerUncached(serverId: string): Promise<GameServerHeartbeat | null> {
        const raw = await this.redis.get(this.keys.gameServer(serverId));
        if (!raw) {
            return null;
        }
        try {
            const value = JSON.parse(raw) as GameServerHeartbeat;
            return value.serverId === serverId && typeof value.protocolVersion === 'number' ? value : null;
        } catch {
            return null;
        }
    }

    private async readLiveRoom(
        roomId: string,
        servers?: Map<string, GameServerHeartbeat | null>,
    ): Promise<RoomDirectoryEntry | null> {
        const raw = await this.redis.get(this.keys.room(roomId));
        if (!raw) {
            return null;
        }
        try {
            const room = JSON.parse(raw) as RoomDirectoryEntry;
            if (!room.serverId || !(await this.readServer(room.serverId, servers))) {
                return null;
            }
            return room;
        } catch {
            return null;
        }
    }

    private toSummary(room: RoomDirectoryEntry) {
        return {
            id: room.roomId ?? room.id,
            roomCode: room.roomCode ?? '',
            name: room.name ?? room.roomName ?? '',
            ownerName: room.ownerName ?? '',
            playerCount: room.playerCount ?? 0,
            capacity: room.capacity ?? MAX_PLAYERS_PER_ROOM,
            hasPassword: Boolean(room.hasPassword),
            status: room.status === 'PLAYING' || room.status === 'playing' ? 'playing' : 'waiting',
        };
    }

    private hasVacancy(room: RoomDirectoryEntry): boolean {
        return (room.playerCount ?? 0) < (room.capacity ?? MAX_PLAYERS_PER_ROOM)
            && room.status !== 'PLAYING'
            && room.status !== 'COUNTDOWN'
            && room.status !== 'playing'
            && room.status !== 'countdown';
    }

    private cleanRoomName(value: string): string {
        const name = value.trim();
        if (!name || /[\u0000-\u001F\u007F]/.test(name)) {
            throw new ConflictException('Room name is invalid');
        }
        return name;
    }

    private async sendCommand<T>(serverId: string, command: ControlCommand): Promise<ControlReply<T>> {
        const startedAt = performance.now();
        const reply = await new Promise<ControlReply>((resolve, reject) => {
            let attempts = 0;
            let settled = false;
            const complete = (value: ControlReply) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            const finishError = (error: Error) => {
                if (settled) return;
                settled = true;
                const pending = this.pending.get(command.requestId);
                if (pending) clearTimeout(pending.timer);
                this.pending.delete(command.requestId);
                reject(error);
            };
            const recoverOrRetry = async (): Promise<void> => {
                if (settled) return;
                try {
                    const stored = await this.redis.get(this.keys.operation(command.requestId));
                    if (settled) return;
                    if (stored) {
                        const recovered = decodeReply(stored);
                        if (recovered.requestId === command.requestId && recovered.serverId === serverId) {
                            this.resolvePendingReply(recovered);
                            return;
                        }
                    }
                } catch { /* Re-enqueueing is safe because requestId is the game server's idempotency key. */ }
                if (Date.now() >= command.deadlineAt || attempts >= 3) {
                    this.logger.warn(`Control command timed out requestId=${command.requestId} serverId=${serverId} attempts=${attempts} elapsedMs=${Math.round(performance.now() - startedAt)}`);
                    finishError(new ServiceUnavailableException({ code: 'COMMAND_TIMEOUT', retryable: true, outcome: 'unknown' }));
                    return;
                }
                await enqueue();
            };
            const enqueue = async (): Promise<void> => {
                if (settled) return;
                attempts += 1;
                try {
                    await this.redis.addStreamEntry(
                        this.keys.commands(serverId),
                        CONTROL_STREAM_FIELDS.command,
                        encodeCommand(command),
                    );
                    /*
                     * 쓰는 쪽에서도 수명을 준다. 읽는 쪽(인게임 서버)이 루프마다 갱신하지만,
                     * 이미 죽은 서버 앞으로 명령을 하나 넣으면 그 순간 키가 되살아나고 아무도
                     * 갱신하지 않는다 — 그러면 감독자가 서버를 띄울 때마다 stream이 하나씩
                     * 영원히 쌓인다.
                     */
                    await this.redis.expire(this.keys.commands(serverId), COMMAND_STREAM_TTL_SECONDS);
                } catch (error) {
                    finishError(error as Error);
                    return;
                }
                const timer = setTimeout(() => void recoverOrRetry(), COMMAND_RETRY_INTERVAL_MS);
                if (settled) {
                    clearTimeout(timer);
                    return;
                }
                this.pending.set(command.requestId, { expectedServerId: serverId, resolve: complete, reject, timer });
            };
            void enqueue();
        });
        this.logger.debug(`Control command completed requestId=${command.requestId} serverId=${serverId} elapsedMs=${Math.round(performance.now() - startedAt)}`);
        return reply as ControlReply<T>;
    }

    private async consumeReplies(): Promise<void> {
        while (!this.stopping) {
            try {
                const entries = await this.redis.readGroup(
                    this.replyStream, ConsumerGroup.Replies, this.consumer, 1_000,
                );
                // 살아 있다는 신호. 갱신이 멈추면 키가 사라져 죽은 인스턴스의 stream이 남지 않는다.
                await this.redis.expire(this.replyStream, REPLY_STREAM_TTL_SECONDS);
                this.replyFailureBackoffMs = 50;
                for (const entry of entries) {
                    try {
                        const rawReply = entry.fields[CONTROL_STREAM_FIELDS.reply];
                        if (!rawReply) {
                            throw new Error('Reply field is missing');
                        }
                        this.resolvePendingReply(decodeReply(rawReply));
                    } catch (error) {
                        this.logger.warn(`Ignoring malformed control reply: ${error instanceof Error ? error.message : String(error)}`);
                    } finally {
                        await this.redis.acknowledge(this.replyStream, ConsumerGroup.Replies, entry.id);
                    }
                }
            } catch (error) {
                if (!this.stopping) {
                    this.logger.error('Failed to consume control replies', error);
                    // TTL이 지나 키가 사라졌으면 그룹도 함께 사라진다(NOGROUP). 다시 만들어야 루프가 산다.
                    await this.redis.ensureConsumerGroup(this.replyStream, ConsumerGroup.Replies).catch(() => undefined);
                    await this.waitForReplyRetry();
                }
            }
        }
    }

    private resolvePendingReply(reply: ControlReply): void {
        const pending = this.pending.get(reply.requestId);
        if (!pending || pending.expectedServerId !== reply.serverId) {
            return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(reply.requestId);
        pending.resolve(reply);
    }

    private async waitForReplyRetry(): Promise<void> {
        const delay = this.replyFailureBackoffMs;
        this.replyFailureBackoffMs = Math.min(this.replyFailureBackoffMs * 2, 1_000);
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            timer.unref();
        });
    }

    private throwControlError(code: string | null): never {
        if (code === ControlErrorCode.RoomNotFound || code === ControlErrorCode.BadPassword) {
            this.throwMaskedRoomError();
        }
        if (code === ControlErrorCode.Expired) {
            throw new ServiceUnavailableException({ code, retryable: true });
        }
        throw new ConflictException({ code: code ?? ControlErrorCode.Internal, message: 'Room reservation was rejected' });
    }

    private throwMaskedRoomError(): never {
        throw new ConflictException({ code: 'ROOM_UNAVAILABLE', message: 'Room not found or password is invalid' });
    }

}
