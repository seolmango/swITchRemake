import { randomUUID } from 'node:crypto';
import {
    type DeleteReplayPayload,
    CONTROL_VERSION,
    CommandType,
    ConsumerGroup,
    ControlErrorCode,
    type ControlCommand,
    type ControlReply,
    type CreateRoomPayload,
    type CreateRoomResult,
    type AdoptRoomPayload,
    type DrainServerPayload,
    type DrainServerResult,
    type KickUserPayload,
    type LobbyStats,
    type RedisKeys,
    type ReleaseSeatPayload,
    type ReserveJoinPayload,
    type ReserveResumePayload,
    type SeatGrant,
} from 'shared';
import { NETWORK } from '../config/network';

/**
 * 명령 stream의 수명. 짧게 잡으면 잠깐 멈춘 서버가 큐에 쌓인 명령을 통째로 잃는다.
 * 응답 stream과 같은 값을 쓴다(매칭 서버의 REPLY_STREAM_TTL_SECONDS).
 */
const COMMAND_STREAM_TTL_MS = 300_000;
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
    /** 'random' sentinel을 실제 맵 id로 바꾼다. 없으면 그대로 통과시킨다(테스트 기본값). */
    readonly resolveMapId?: (mapId: string) => string;
    /**
     * DRAIN_SERVER 명령을 받았을 때 부를 것. 생략하면 명령을 거절한다.
     *
     * 여기서 종료까지 기다리지 않는다 — 방이 다 빌 때까지 몇 분이 걸릴 수 있고, 그동안 명령
     * 소비자가 멈춰 있으면 재접속 예약(RESERVE_RESUME)을 처리할 수 없다. 남은 사람을 위해
     * 계속 돌아야 하는 바로 그 경로다.
     */
    readonly beginDrain?: () => void;
    /**
     * DELETE_REPLAY 명령을 받았을 때 파일을 지울 것. 리플레이 기록이 꺼진 서버에는 없다.
     *
     * 없으면 명령을 거절한다 — 지우지 않고 지웠다고 답하면 매칭 서버가 행을 지우고 파일만
     * 디스크에 남는다. 아무도 그 파일을 다시 찾지 못한다.
     */
    readonly deleteReplay?: (storageKey: string) => Promise<void>;
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
            /*
             * 살아 있다는 신호. 감독자가 서버를 띄울 때마다 새 id를 쓰기 때문에, 갱신이 멈추면
             * 사라지게 해 두지 않으면 죽은 서버의 명령 stream이 Redis에 영원히 쌓인다.
             */
            await this.#options.redis.expire(stream, COMMAND_STREAM_TTL_MS);
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
            let replyTo: string | null = null;
            try {
                const candidate = JSON.parse(raw) as unknown;
                if (candidate !== null && typeof candidate === 'object') {
                    const fields = candidate as Record<string, unknown>;
                    if (isControlRequestId(fields['requestId'])) requestId = fields['requestId'] as string;
                    // 명령이 깨졌어도 주소는 읽힐 수 있다. 읽히면 원 요청자가 즉시 실패를 받는다.
                    if (typeof fields['replyTo'] === 'string' && fields['replyTo'].length > 0) {
                        replyTo = fields['replyTo'];
                    }
                }
            } catch { /* synthetic requestId keeps the poison entry correlatable */ }
            await this.#replyAndAckPoison(entry, requestId, replyTo);
            return;
        }

        const reply = await this.#replyFor(command);
        // 결과가 stream에 기록된 뒤에만 ack한다. 이 순서는 테스트로 고정한다.
        // 보낸 인스턴스가 적어 준 주소로 답한다. 공용 stream에 넣으면 다른 인스턴스가 가져가 버린다.
        await this.#options.redis.xAdd(
            command.replyTo,
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

    /**
     * 주소를 모르는 답은 사서함(`keys.replies()`)으로 간다. 아무도 읽지 않는다 — 명령이 깨져서
     * 여기까지 온 것이라 원 요청자는 어차피 상관관계를 만들 수 없고 타임아웃으로 복구한다.
     */
    async #replyAndAckPoison(entry: StreamEntry, requestId: string, replyTo: string | null = null): Promise<void> {
        const reply: ControlReply = {
            v: CONTROL_VERSION,
            requestId,
            serverId: this.#options.serverId,
            ok: false,
            code: ControlErrorCode.Internal,
            payload: null,
        };
        await this.#options.redis.xAdd(
            replyTo ?? this.#options.keys.replies(),
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
            case CommandType.DrainServer:
                return this.#drainServer(command, command.payload as DrainServerPayload);
            case CommandType.AdoptRoom:
                return this.#adoptRoom(command, command.payload as AdoptRoomPayload);
            case CommandType.DeleteReplay:
                return this.#deleteReplay(command, command.payload as DeleteReplayPayload);
            default:
                return failure(this.#options.serverId, command, ControlErrorCode.Internal);
        }
    }

    /**
     * 이 서버를 재운다. 신규 방·참가는 이 시점부터 거절되고, 남은 방이 다 비면 스스로 종료한다.
     *
     * 같은 명령이 두 번 와도 안전하다 — 이미 draining이면 남은 방 수만 다시 알려 준다.
     */
    #drainServer(command: ControlCommand, payload: DrainServerPayload): ControlReply<DrainServerResult> {
        if (payload.serverId !== this.#options.serverId) {
            return failure(this.#options.serverId, command, ControlErrorCode.RoomNotFound);
        }
        if (this.#options.beginDrain === undefined) {
            return failure(this.#options.serverId, command, ControlErrorCode.Internal);
        }
        this.#options.beginDrain();
        return success(this.#options.serverId, command, { remainingRooms: this.#options.rooms.size });
    }

    /**
     * 다른 서버가 들고 있던 방을 넘겨받는다.
     *
     * 재우는 중인 서버는 받지 않는다. 곧 사라질 프로세스에 방을 얹으면 그 방이 한 번 더
     * 옮겨 다녀야 하고, 사람들은 재접속을 두 번 겪는다.
     */
    async #adoptRoom(command: ControlCommand, payload: AdoptRoomPayload): Promise<ControlReply<Record<string, never>>> {
        if (payload.serverId !== this.#options.serverId) {
            return failure(this.#options.serverId, command, ControlErrorCode.RoomNotFound);
        }
        if (this.#options.isDraining()) {
            return failure(this.#options.serverId, command, ControlErrorCode.ServerDraining);
        }
        const adopted = this.#options.rooms.adoptRoom(payload);
        if (!adopted.ok) return failure(this.#options.serverId, command, adopted.code);
        // 자리 표를 먼저 여기로 돌린다. 방 디렉터리만 바뀌고 표가 옛 서버를 가리키면 매칭 서버가
        // 둘을 대조해 전원을 ROOM_UNAVAILABLE로 튕긴다.
        //
        // 기다린다. 예전에는 던져 놓고 성공을 답했는데, 그러면 표가 실제로 옮겨졌는지 모르는 채
        // 인계가 확정되고 Redis 실패는 unhandled rejection으로 프로세스를 내린다. 일부만 옮겨진
        // 방은 그 사람들만 돌아오지 못하는, 가장 알아채기 어려운 상태다.
        try {
            await this.#options.registry.claimAdoptedRoom(
                payload.roomId,
                payload.members.map((member) => member.userId),
            );
        } catch (error: unknown) {
            this.#logger(`인계받은 방의 자리 표를 옮기지 못했다 roomId=${payload.roomId}`, error);
            // 방을 접어 두면 넘긴 쪽이 다시 시도할 수 있다. 표가 옛 서버를 가리키는 채로 두는
            // 편이, 여기 있지만 아무도 못 찾는 방으로 두는 것보다 낫다.
            adopted.value.close();
            this.#options.rooms.sweep();
            return failure(this.#options.serverId, command, ControlErrorCode.Internal);
        }
        // 방이 여기 있다는 사실을 즉시 알린다. heartbeat 주기를 기다리면 그동안의 재접속이
        // 옛 서버로 간다.
        this.#options.registry.requestPublish();
        return success(this.#options.serverId, command, {});
    }

    #reservation(
        userId: SeatReservation['userId'],
        nickname: string,
        roomId: string,
        resume: boolean,
        lobbyStats: LobbyStats | null = null,
    ): SeatReservation {
        const issuedAt = this.#now();
        return {
            userId,
            nickname,
            lobbyStats,
            roomId,
            serverId: this.#options.serverId,
            issuedAt,
            expiresAt: issuedAt + NETWORK.SEAT_RESERVATION_TTL_MS,
            resume,
        };
    }

    #createRoom(command: ControlCommand, payload: CreateRoomPayload): ControlReply<CreateRoomResult> {
        const roomId = this.#roomIdFactory();
        const reservation = this.#reservation(payload.ownerUserId, payload.ownerNickname, roomId, false, payload.ownerStats);
        const mapId = this.#options.resolveMapId ? this.#options.resolveMapId(payload.mapId) : payload.mapId;
        const created = this.#options.rooms.createRoom({
            id: roomId,
            roomCode: payload.roomCode,
            matchId: payload.matchId,
            name: payload.roomName,
            password: payload.password,
            capacity: payload.capacity,
            mapId,
            ownerReservation: reservation,
            ...(payload.mode === undefined ? {} : { mode: payload.mode }),
        });
        if (!created.ok) return failure(this.#options.serverId, command, created.code);
        try {
            const issued = this.#options.tickets.issue(reservation);
            this.#options.registry.trackSeat(roomId, payload.ownerUserId, command.requestId);
            return success(this.#options.serverId, command, {
                roomId,
                roomCode: payload.roomCode,
                mapId,
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

        const reservation = this.#reservation(payload.userId, payload.nickname, payload.roomId, false, payload.stats);
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

    /**
     * 보관 기간이 끝난 리플레이 파일을 지운다.
     *
     * 이미 없는 파일도 성공이다(`rm`이 force로 돈다). 같은 명령이 두 번 와도 결과가 같아야
     * 정리 작업이 안심하고 재시도할 수 있다.
     */
    async #deleteReplay(command: ControlCommand, payload: DeleteReplayPayload): Promise<ControlReply<Record<string, never>>> {
        const remove = this.#options.deleteReplay;
        if (remove === undefined) {
            this.#options.logger?.('DELETE_REPLAY를 받았지만 이 서버에는 리플레이 저장소가 없다');
            return failure(this.#options.serverId, command, ControlErrorCode.Internal);
        }
        try {
            await remove(payload.storageKey);
        } catch (error) {
            this.#options.logger?.('리플레이 파일 삭제 실패', error);
            return failure(this.#options.serverId, command, ControlErrorCode.Internal);
        }
        return success(this.#options.serverId, command, {});
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
