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
import { randomUUID } from 'node:crypto';
import {
    CommandType,
    ConsumerGroup,
    CONTROL_VERSION,
    ControlErrorCode,
    MAX_PLAYERS_PER_ROOM,
    PROTOCOL_VERSION,
    makeKeys,
    type ActorId,
    type ControlCommand,
    type ControlReply,
    type CreateRoomResult,
    type GameServerHeartbeat,
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

const COMMAND_TIMEOUT_MS = 2_000;
const ACTIVE_ROOM_RESERVATION_TTL_SECONDS = 30;
const JOIN_RATE_LIMIT = 6;
const JOIN_RATE_WINDOW_SECONDS = 60;
const REJOIN_COOLDOWN_SECONDS = 60;
const ROOM_LIST_PAGE_SIZE = 20;

interface Actor {
    id: ActorId;
    nickname: string;
    guest: boolean;
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

type ClientSeatGrant = SeatGrant & { roomId: string };

@Injectable()
export class RoomsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RoomsService.name);
    private readonly keys: ReturnType<typeof makeKeys>;
    private readonly consumer = `matching-${randomUUID()}`;
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
    }

    async onModuleInit(): Promise<void> {
        await this.redis.ensureConsumerGroup(this.keys.replies(), ConsumerGroup.Replies);
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

    async list(page = 1) {
        const safePage = Number.isInteger(page) && page > 0 ? page : 1;
        const ids = await this.redis.sortedSetMembers(this.keys.roomsWaiting(), 0, -1);
        const rooms = (await Promise.all(ids.map((id) => this.readLiveRoom(id))))
            .filter((room): room is RoomDirectoryEntry => room !== null)
            .map((room) => this.toSummary(room));
        const total = rooms.length;
        const totalPages = Math.max(1, Math.ceil(total / ROOM_LIST_PAGE_SIZE));
        const currentPage = Math.min(safePage, totalPages);
        const offset = (currentPage - 1) * ROOM_LIST_PAGE_SIZE;
        return {
            rooms: rooms.slice(offset, offset + ROOM_LIST_PAGE_SIZE),
            page: currentPage,
            totalPages,
            total,
        };
    }

    async create(principal: ActorId | RoomPrincipal, dto: CreateRoomDto, clientIp?: string) {
        const actor = await this.requireActor(principal);
        await this.enforceActorRate(actor.id, 'room-create-rate');
        await this.enforceGuestIpRate(actor, clientIp, 'room-create-rate');
        const roomName = this.cleanRoomName(dto.name);
        const requestId = randomUUID();
        const claim = await this.claimActiveRoom(actor.id, requestId);
        if (!claim) {
            return this.existingRoomResponse(actor.id);
        }

        let issuedMatchId: string | null = null;
        try {
            const server = await this.selectServer();
            issuedMatchId = randomUUID();
            await this.results.issueMatch(issuedMatchId, server.serverId, dto.mapId ?? 'random', actor);
            const reply = await this.sendCommand<CreateRoomResult>(server.serverId, {
                v: CONTROL_VERSION,
                requestId,
                type: CommandType.CreateRoom,
                issuedAt: Date.now(),
                deadlineAt: Date.now() + COMMAND_TIMEOUT_MS,
                payload: {
                    matchId: issuedMatchId,
                    roomName,
                    password: dto.password?.length ? dto.password : null,
                    ownerUserId: actor.id,
                    ownerNickname: actor.nickname,
                    capacity: dto.capacity ?? MAX_PLAYERS_PER_ROOM,
                    mapId: dto.mapId ?? 'random',
                },
            });
            if (!reply.ok || !reply.payload) {
                await this.redis.compareAndDelete(this.keys.userActiveRoom(actor.id), claim);
                await this.results.discardIssuedMatch(issuedMatchId);
                this.throwControlError(reply.code);
            }

            await this.results.confirmRoom(issuedMatchId, reply.payload.roomId);
            await this.assignActiveRoom(actor.id, claim, requestId, reply.serverId, reply.payload.roomId);
            return reply.payload;
        } catch (error) {
            if (!this.mustKeepReservationUntilExpiry(error)) {
                await this.redis.compareAndDelete(this.keys.userActiveRoom(actor.id), claim);
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
                deadlineAt: Date.now() + COMMAND_TIMEOUT_MS,
                payload: { roomId, userId: actor.id, nickname: actor.nickname, password: password?.length ? password : null },
            });
            if (!reply.ok || !reply.payload) {
                await this.redis.compareAndDelete(this.keys.userActiveRoom(actor.id), claim);
                await this.results.removeAssignment(assignedMatchId, actor.id);
                this.throwControlError(reply.code);
            }
            await this.assignActiveRoom(actor.id, claim, requestId, reply.serverId, roomId);
            return { roomId, ...reply.payload };
        } catch (error) {
            if (!this.mustKeepReservationUntilExpiry(error)) {
                await this.redis.compareAndDelete(this.keys.userActiveRoom(actor.id), claim);
            }
            throw error;
        }
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
                const reply = await this.sendCommand<SeatGrant>(room.serverId, {
                    v: CONTROL_VERSION,
                    requestId: randomUUID(),
                    type: CommandType.ReserveJoin,
                    issuedAt: Date.now(),
                    deadlineAt: Date.now() + COMMAND_TIMEOUT_MS,
                    payload: { roomId: candidate.roomId, userId: actor.id, nickname: actor.nickname, password: null },
                });
                if (reply.ok && reply.payload) {
                    await this.assignActiveRoom(actor.id, claim, requestId, reply.serverId, candidate.roomId);
                    return { roomId: candidate.roomId, ...reply.payload };
                }
                await this.results.removeAssignment(assignedMatchId, actor.id);
                if (reply.code === ControlErrorCode.RoomNotFound || reply.code === ControlErrorCode.BadPassword) {
                    continue;
                }
            }
            await this.redis.compareAndDelete(this.keys.userActiveRoom(actor.id), claim);
            throw new ConflictException({ code: 'NO_JOINABLE_ROOM', message: 'No joinable room is available' });
        } catch (error) {
            if (!this.mustKeepReservationUntilExpiry(error)) {
                await this.redis.compareAndDelete(this.keys.userActiveRoom(actor.id), claim);
            }
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
            deadlineAt: Date.now() + COMMAND_TIMEOUT_MS,
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
        return { roomId, ...reply.payload };
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
            return { id: identity.id, nickname: identity.nickname, guest: true };
        }
        const userId = identity.id;
        const [user] = await this.db.select({
            id: schema.users.id,
            nickname: schema.users.nickname,
            accountStatus: schema.users.accountStatus,
        }).from(schema.users).where(eq(schema.users.id, userId));
        if (!user) {
            throw new ForbiddenException('Account is not active');
        }
        const status = await this.sanctions.reconcileLoginStatus(user.id, user.accountStatus);
        if (status !== 'ACTIVE') {
            throw new ForbiddenException('Account is not active');
        }
        return { id: user.id, nickname: user.nickname, guest: false };
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

    private async existingRoomResponse(userId: ActorId): Promise<{ alreadyAssigned: true; roomId?: string }> {
        const raw = await this.redis.get(this.keys.userActiveRoom(userId));
        if (!raw) {
            // A just-expired reservation raced this request. The caller may retry.
            throw new ServiceUnavailableException({ code: 'ACTIVE_ROOM_RACE', retryable: true });
        }
        try {
            const claim = JSON.parse(raw) as ActiveRoomClaim;
            return claim.state === 'assigned'
                ? { alreadyAssigned: true, roomId: claim.roomId }
                : { alreadyAssigned: true };
        } catch {
            return { alreadyAssigned: true };
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
            .filter((server) => !server.draining && server.protocolVersion === PROTOCOL_VERSION);
        if (!candidates.length) {
            throw new ServiceUnavailableException({ code: 'NO_GAME_SERVER', retryable: true });
        }
        candidates.sort((a, b) => this.serverLoad(a) - this.serverLoad(b) || a.serverId.localeCompare(b.serverId));
        return candidates[0];
    }

    private serverLoad(server: GameServerHeartbeat): number {
        return server.waitingRooms + server.playingRooms + server.connections / MAX_PLAYERS_PER_ROOM + server.loopLagMs / 1000;
    }

    private async readServer(serverId: string): Promise<GameServerHeartbeat | null> {
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

    private async readLiveRoom(roomId: string): Promise<RoomDirectoryEntry | null> {
        const raw = await this.redis.get(this.keys.room(roomId));
        if (!raw) {
            return null;
        }
        try {
            const room = JSON.parse(raw) as RoomDirectoryEntry;
            if (!room.serverId || !(await this.readServer(room.serverId))) {
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
        const reply = await new Promise<ControlReply>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(command.requestId);
                reject(new ServiceUnavailableException({ code: 'COMMAND_TIMEOUT', retryable: true }));
            }, COMMAND_TIMEOUT_MS);
            this.pending.set(command.requestId, { expectedServerId: serverId, resolve, reject, timer });
            void this.redis.addStreamEntry(
                this.keys.commands(serverId),
                CONTROL_STREAM_FIELDS.command,
                encodeCommand(command),
            ).catch((error: Error) => {
                clearTimeout(timer);
                this.pending.delete(command.requestId);
                reject(error);
            });
        });
        return reply as ControlReply<T>;
    }

    private async consumeReplies(): Promise<void> {
        while (!this.stopping) {
            try {
                const entries = await this.redis.readGroup(
                    this.keys.replies(), ConsumerGroup.Replies, this.consumer, 1_000,
                );
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
                        await this.redis.acknowledge(this.keys.replies(), ConsumerGroup.Replies, entry.id);
                    }
                }
            } catch (error) {
                if (!this.stopping) {
                    this.logger.error('Failed to consume control replies', error);
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

    private mustKeepReservationUntilExpiry(error: unknown): boolean {
        if (!(error instanceof ServiceUnavailableException)) {
            return false;
        }
        const response = error.getResponse();
        return typeof response === 'object'
            && response !== null
            && (response as { code?: string }).code === 'COMMAND_TIMEOUT';
    }
}
