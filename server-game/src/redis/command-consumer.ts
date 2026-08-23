import { randomUUID } from 'node:crypto';
import {
    CONTROL_VERSION,
    CommandType,
    ConsumerGroup,
    ControlErrorCode,
    type ControlCommand,
    type ControlReply,
    type CreateRoomPayload,
    type CreateRoomResult,
    type KickUserPayload,
    type RedisKeys,
    type ReleaseSeatPayload,
    type ReserveJoinPayload,
    type ReserveResumePayload,
    type SeatGrant,
} from 'shared';
import { NETWORK } from '../config/network';
import type { SeatReservation, TicketStore } from '../gateway/ticket-store';
import type { RoomManager } from '../rooms/room-manager';
import { CONTROL_STREAM_FIELDS, decodeCommand, decodeStoredReply, encodeReply, isControlRequestId } from './control-codec';
import type { GameRegistry } from './registry';
import type { RedisPort, StreamEntry } from './redis-client';

export interface CommandConsumerOptions {
    readonly redis: RedisPort;
    readonly keys: RedisKeys;
    readonly serverId: string;
    readonly wsPath: string;
    readonly consumerId: string;
    readonly rooms: RoomManager;
    readonly tickets: TicketStore;
    readonly registry: GameRegistry;
    readonly isDraining: () => boolean;
    readonly now?: () => number;
    readonly roomIdFactory?: () => string;
    readonly logger?: (message: string, error?: unknown) => void;
    readonly readBlockMs?: number;
    readonly readCount?: number;
}

interface CachedReply {
    readonly reply: ControlReply;
    /** null인 동안에는 stream entry가 아직 ACK되지 않았으므로 제거하지 않는다. */
    expiresAt: number | null;
}

function success<T>(serverId: string, command: ControlCommand, payload: T): ControlReply<T> {
    return { v: CONTROL_VERSION, requestId: command.requestId, serverId, ok: true, code: null, payload };
}

function failure<T = unknown>(
    serverId: string,
    command: ControlCommand,
    code: typeof ControlErrorCode[keyof typeof ControlErrorCode],
): ControlReply<T> {
    return { v: CONTROL_VERSION, requestId: command.requestId, serverId, ok: false, code, payload: null };
}

/** Redis Stream의 at-least-once delivery를 requestId 결과 캐시로 멱등 처리한다. */
export class CommandConsumer {
    readonly #options: CommandConsumerOptions;
    readonly #now: () => number;
    readonly #roomIdFactory: () => string;
    readonly #logger: NonNullable<CommandConsumerOptions['logger']>;
    readonly #localOperations = new Map<string, CachedReply>();
    #groupReady = false;
    #running = false;
    #loop: Promise<void> | null = null;

    public constructor(options: CommandConsumerOptions) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
        this.#roomIdFactory = options.roomIdFactory ?? randomUUID;
        this.#logger = options.logger ?? (() => undefined);
    }

    public async start(): Promise<void> {
        if (this.#running) return;
        await this.#ensureGroup();
        this.#running = true;
        this.#loop = this.#run();
    }

    public async stop(): Promise<void> {
        this.#running = false;
        await this.#loop;
        this.#loop = null;
    }

    /** 테스트와 수동 조립에서 한 번만 poll한다. */
    public async pollOnce(): Promise<number> {
        if (!this.#options.redis.isReady()) return 0;
        await this.#ensureGroup();
        const stream = this.#options.keys.commands(this.#options.serverId);
        const count = this.#options.readCount ?? 10;
        let reclaimed: StreamEntry[];
        let fresh: StreamEntry[];
        try {
            reclaimed = await this.#options.redis.xAutoClaim(
                stream,
                ConsumerGroup.Commands,
                this.#options.consumerId,
                NETWORK.STREAM_AUTOCLAIM_IDLE_MS,
                count,
            );
            fresh = await this.#options.redis.xReadGroup(
                stream,
                ConsumerGroup.Commands,
                this.#options.consumerId,
                this.#options.readBlockMs ?? 1_000,
                count,
            );
        } catch (error: unknown) {
            // Redis 재시작/flush로 group이 사라진 경우 다음 poll에서 다시 만든다.
            this.#groupReady = false;
            throw error;
        }
        const seen = new Set<string>();
        const entries = [...reclaimed, ...fresh].filter((entry) => {
            if (seen.has(entry.id)) return false;
            seen.add(entry.id);
            return true;
        });
        for (const entry of entries) await this.#process(entry);
        return entries.length;
    }

    async #run(): Promise<void> {
        let backoffMs = 50;
        while (this.#running) {
            try {
                const processed = await this.pollOnce();
                backoffMs = processed === 0 ? Math.min(backoffMs * 2, 1_000) : 50;
            } catch (error: unknown) {
                this.#logger('Redis command consumer paused; no command was acknowledged', error);
                backoffMs = Math.min(backoffMs * 2, 1_000);
            }
            if (this.#running) await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
        }
    }

    async #ensureGroup(): Promise<void> {
        if (this.#groupReady) return;
        await this.#options.redis.xGroupCreate(
            this.#options.keys.commands(this.#options.serverId),
            ConsumerGroup.Commands,
            '0',
        );
        this.#groupReady = true;
    }

    async #process(entry: StreamEntry): Promise<void> {
        const raw = entry.fields[CONTROL_STREAM_FIELDS.command];
        if (raw === undefined) {
            this.#logger(`Ignoring command stream entry ${entry.id} without command field`);
            await this.#replyAndAckPoison(entry, `invalid:${this.#options.serverId}:${entry.id}`);
            return;
        }

        let command: ControlCommand;
        try {
            command = decodeCommand(raw);
        } catch (error: unknown) {
            this.#logger(`Ignoring malformed command stream entry ${entry.id}`, error);
            let requestId = `invalid:${this.#options.serverId}:${entry.id}`;
            try {
                const candidate = JSON.parse(raw) as unknown;
                if (candidate !== null && typeof candidate === 'object'
                    && isControlRequestId((candidate as Record<string, unknown>)['requestId'])) {
                    requestId = (candidate as Record<string, string>)['requestId']!;
                }
            } catch { /* synthetic requestId keeps the poison entry correlatable */ }
            await this.#replyAndAckPoison(entry, requestId);
            return;
        }

        const reply = await this.#replyFor(command);
        // 결과가 stream에 기록된 뒤에만 ack한다. 이 순서는 테스트로 고정한다.
        await this.#options.redis.xAdd(
            this.#options.keys.replies(),
            CONTROL_STREAM_FIELDS.reply,
            encodeReply(reply),
            NETWORK.STREAM_MAXLEN,
        );
        await this.#options.redis.xAck(
            this.#options.keys.commands(this.#options.serverId),
            ConsumerGroup.Commands,
            entry.id,
        );
        const cached = this.#localOperations.get(command.requestId);
        if (cached !== undefined) cached.expiresAt = this.#now() + NETWORK.OPERATION_RESULT_TTL_MS;
    }

    async #replyAndAckPoison(entry: StreamEntry, requestId: string): Promise<void> {
        const reply: ControlReply = {
            v: CONTROL_VERSION,
            requestId,
            serverId: this.#options.serverId,
            ok: false,
            code: ControlErrorCode.Internal,
            payload: null,
        };
        await this.#options.redis.xAdd(
            this.#options.keys.replies(),
            CONTROL_STREAM_FIELDS.reply,
            encodeReply(reply),
            NETWORK.STREAM_MAXLEN,
        );
        await this.#options.redis.xAck(
            this.#options.keys.commands(this.#options.serverId),
            ConsumerGroup.Commands,
            entry.id,
        );
    }

    async #replyFor(command: ControlCommand): Promise<ControlReply> {
        const now = this.#now();
        for (const [requestId, cached] of this.#localOperations) {
            if (cached.expiresAt !== null && cached.expiresAt <= now) this.#localOperations.delete(requestId);
        }
        const operationKey = this.#options.keys.operation(command.requestId);
        const local = this.#localOperations.get(command.requestId);
        if (local !== undefined) {
            local.expiresAt = null;
            await this.#options.redis.setPx(operationKey, encodeReply(local.reply), NETWORK.OPERATION_RESULT_TTL_MS);
            return local.reply;
        }

        const stored = await this.#options.redis.get(operationKey);
        if (stored !== null) {
            const reply = decodeStoredReply(stored);
            if (reply !== null && reply.requestId === command.requestId && reply.serverId === this.#options.serverId) {
                this.#localOperations.set(command.requestId, { reply, expiresAt: null });
                await this.#options.redis.setPx(operationKey, encodeReply(reply), NETWORK.OPERATION_RESULT_TTL_MS);
                return reply;
            }
        }

        const reply = now > command.deadlineAt
            ? failure(this.#options.serverId, command, ControlErrorCode.Expired)
            : await this.#execute(command);
        const cached: CachedReply = { reply, expiresAt: null };
        this.#localOperations.set(command.requestId, cached);
        await this.#options.redis.setPx(operationKey, encodeReply(reply), NETWORK.OPERATION_RESULT_TTL_MS);
        return reply;
    }

    async #execute(command: ControlCommand): Promise<ControlReply> {
        if (this.#options.isDraining()
            && (command.type === CommandType.CreateRoom || command.type === CommandType.ReserveJoin)) {
            return failure(this.#options.serverId, command, ControlErrorCode.ServerDraining);
        }
        switch (command.type) {
            case CommandType.CreateRoom:
                return this.#createRoom(command, command.payload as CreateRoomPayload);
            case CommandType.ReserveJoin:
                return this.#reserveJoin(command, command.payload as ReserveJoinPayload);
            case CommandType.ReserveResume:
                return this.#reserveResume(command, command.payload as ReserveResumePayload);
            case CommandType.ReleaseSeat:
                return this.#releaseSeat(command, command.payload as ReleaseSeatPayload);
            case CommandType.KickUser:
                return this.#kickUser(command, command.payload as KickUserPayload);
            default:
                return failure(this.#options.serverId, command, ControlErrorCode.Internal);
        }
    }

    #reservation(userId: SeatReservation['userId'], nickname: string, roomId: string, resume: boolean): SeatReservation {
        const issuedAt = this.#now();
        return {
            userId,
            nickname,
            lobbyStats: null,
            roomId,
            serverId: this.#options.serverId,
            issuedAt,
            expiresAt: issuedAt + NETWORK.SEAT_RESERVATION_TTL_MS,
            resume,
        };
    }

    #createRoom(command: ControlCommand, payload: CreateRoomPayload): ControlReply<CreateRoomResult> {
        const roomId = this.#roomIdFactory();
        const reservation = this.#reservation(payload.ownerUserId, payload.ownerNickname, roomId, false);
        const created = this.#options.rooms.createRoom({
            id: roomId,
            matchId: payload.matchId,
            name: payload.roomName,
            password: payload.password,
            capacity: payload.capacity,
            mapId: payload.mapId,
            ownerReservation: reservation,
        });
        if (!created.ok) return failure(this.#options.serverId, command, created.code);
        try {
            const issued = this.#options.tickets.issue(reservation);
            this.#options.registry.trackSeat(roomId, payload.ownerUserId, command.requestId);
            return success(this.#options.serverId, command, {
                roomId,
                wsPath: this.#options.wsPath,
                ticket: issued.ticket,
                expiresAt: issued.expiresAt,
            });
        } catch {
            this.#options.rooms.releaseSeat(roomId, payload.ownerUserId);
            return failure(this.#options.serverId, command, ControlErrorCode.Internal);
        }
    }

    async #reserveJoin(command: ControlCommand, payload: ReserveJoinPayload): Promise<ControlReply<SeatGrant>> {
        const [cooldown, kicked] = await Promise.all([
            this.#options.redis.get(this.#options.keys.roomRejoin(payload.roomId, payload.userId)),
            this.#options.redis.get(this.#options.keys.operation(`room-kicked:${payload.roomId}:${payload.userId}`)),
        ]);
        if (cooldown !== null) return failure(this.#options.serverId, command, ControlErrorCode.RejoinCooldown);
        if (kicked !== null) return failure(this.#options.serverId, command, ControlErrorCode.KickedFromRoom);

        const reservation = this.#reservation(payload.userId, payload.nickname, payload.roomId, false);
        const reserved = this.#options.rooms.reserveJoin(reservation, payload.password);
        if (!reserved.ok) return failure(this.#options.serverId, command, reserved.code);
        try {
            const issued = this.#options.tickets.issue(reservation);
            this.#options.registry.trackSeat(payload.roomId, payload.userId, command.requestId);
            return success(this.#options.serverId, command, {
                wsPath: this.#options.wsPath,
                ticket: issued.ticket,
                expiresAt: issued.expiresAt,
            });
        } catch {
            this.#options.rooms.releaseSeat(payload.roomId, payload.userId);
            return failure(this.#options.serverId, command, ControlErrorCode.Internal);
        }
    }

    #reserveResume(command: ControlCommand, payload: ReserveResumePayload): ControlReply<SeatGrant> {
        const member = this.#options.rooms.get(payload.roomId)?.memberByUser(payload.userId) ?? null;
        if (member === null) return failure(this.#options.serverId, command, ControlErrorCode.NoGraceSlot);
        const reservation: SeatReservation = {
            ...this.#reservation(payload.userId, member.nickname, payload.roomId, true),
            lobbyStats: member.stats,
        };
        const reserved = this.#options.rooms.reserveResume(reservation);
        if (!reserved.ok) return failure(this.#options.serverId, command, reserved.code);
        try {
            const issued = this.#options.tickets.issue(reservation);
            this.#options.registry.trackSeat(payload.roomId, payload.userId, command.requestId);
            return success(this.#options.serverId, command, {
                wsPath: this.#options.wsPath,
                ticket: issued.ticket,
                expiresAt: issued.expiresAt,
            });
        } catch {
            return failure(this.#options.serverId, command, ControlErrorCode.Internal);
        }
    }

    #releaseSeat(command: ControlCommand, payload: ReleaseSeatPayload): ControlReply<Record<string, never>> {
        const joined = (this.#options.rooms.get(payload.roomId)?.memberByUser(payload.userId) ?? null) !== null;
        const result = this.#options.rooms.releaseSeat(payload.roomId, payload.userId);
        if (!result.ok) return failure(this.#options.serverId, command, result.code);
        this.#options.registry.noteReleased(payload.roomId, payload.userId, joined);
        return success(this.#options.serverId, command, {});
    }

    #kickUser(command: ControlCommand, payload: KickUserPayload): ControlReply<Record<string, never>> {
        const joined = (this.#options.rooms.get(payload.roomId)?.memberByUser(payload.userId) ?? null) !== null;
        const result = this.#options.rooms.kickUser(payload.roomId, payload.userId, payload.reason);
        if (!result.ok) return failure(this.#options.serverId, command, result.code);
        this.#options.registry.noteKicked(payload.roomId, payload.userId);
        this.#options.registry.noteReleased(payload.roomId, payload.userId, joined);
        return success(this.#options.serverId, command, {});
    }
}
