import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { CONTROL_VERSION, CommandType, ControlErrorCode, PROTOCOL_VERSION, type ControlCommand, type ControlReply } from 'shared';
import { RoomsService } from './rooms.service';

class FakeRedis {
    readonly values = new Map<string, string>();
    readonly ttls = new Map<string, number>();
    readonly sorted = new Map<string, string[]>();
    readonly streamWrites: Array<{ stream: string; field: string; value: string }> = [];

    async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
    async set(key: string, value: string, ttl?: number): Promise<void> {
        this.values.set(key, value);
        if (ttl) this.ttls.set(key, ttl * 1000);
    }
    async setIfAbsent(key: string, value: string, ttl: number): Promise<boolean> {
        if (this.values.has(key)) return false;
        await this.set(key, value, ttl);
        return true;
    }
    async compareAndDelete(key: string, expected: string): Promise<boolean> {
        if (this.values.get(key) !== expected) return false;
        this.values.delete(key);
        return true;
    }
    async compareAndSetWithTtl(key: string, expected: string, value: string, ttl: number): Promise<boolean> {
        if (this.values.get(key) !== expected) return false;
        await this.set(key, value, ttl);
        return true;
    }
    async ttlMilliseconds(key: string): Promise<number> { return this.ttls.get(key) ?? -2; }
    async incrementWithTtl(key: string, ttl: number): Promise<number> {
        const count = Number(this.values.get(key) ?? '0') + 1;
        await this.set(key, String(count), ttl);
        return count;
    }
    async sortedSetMembers(key: string): Promise<string[]> { return this.sorted.get(key) ?? []; }
    async addStreamEntry(stream: string, field: string, value: string): Promise<string> {
        this.streamWrites.push({ stream, field, value });
        return '1-0';
    }
}

function makeService(redis = new FakeRedis(), stats: unknown = null): RoomsService {
    const db = {
        select: () => ({
            from: () => ({
                where: async () => [{ id: 1, nickname: 'Alice', accountStatus: 'ACTIVE', stats }],
            }),
        }),
    };
    const sanctions = { reconcileLoginStatus: async () => 'ACTIVE' };
    const results = {
        addAssignmentByRoom: async () => '11111111-1111-4111-8111-111111111111',
        removeAssignment: async () => undefined,
        issueMatch: async () => undefined,
        confirmRoom: async () => undefined,
        discardIssuedMatch: async () => undefined,
    };
    const sessionSecurity = { hmacIp: (ip: string) => `hmac:${ip}` };
    return new RoomsService(db as never, redis as never, sanctions as never, results as never, sessionSecurity as never);
}

function addLiveRoom(redis: FakeRedis, roomId: string, serverId = 'game-a', hasPassword = false): void {
    redis.values.set(`dev:room:${roomId}`, JSON.stringify({
        roomId,
        roomCode: 'ABC234',
        serverId,
        name: roomId,
        ownerName: 'Host',
        playerCount: 1,
        capacity: 8,
        hasPassword,
        status: 'WAITING',
    }));
    redis.values.set(`dev:game-server:${serverId}`, JSON.stringify({
        serverId,
        protocolVersion: 1,
        waitingRooms: 1,
        playingRooms: 0,
        connections: 1,
        loopLagMs: 0,
        draining: false,
    }));
}

test('active-room claim is NX and cannot be silently replaced', async () => {
    const redis = new FakeRedis();
    const service = makeService(redis);

    const first = await (service as any).claimActiveRoom(1, 'request-one');
    const second = await (service as any).claimActiveRoom(1, 'request-two');

    assert.ok(first);
    assert.equal(second, null);
    assert.match(redis.values.get('dev:user:1:active-room')!, /request-one/);
});

test('room-not-found and bad-password replies are externally masked alike', async () => {
    const redis = new FakeRedis();
    addLiveRoom(redis, 'private-room', 'game-a', true);
    const service = makeService(redis);
    (service as any).sendCommand = async (): Promise<ControlReply> => ({
        v: CONTROL_VERSION,
        requestId: 'request',
        serverId: 'game-a',
        ok: false,
        code: ControlErrorCode.BadPassword,
        payload: null,
    });

    await assert.rejects(service.join(1, 'private-room', 'wrong'), (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.deepEqual(error.getResponse(), {
            code: 'ROOM_UNAVAILABLE',
            message: 'Room not found or password is invalid',
        });
        return true;
    });
});

test('quick join skips cooldown and kick-marked rooms before issuing a command', async () => {
    const redis = new FakeRedis();
    redis.sorted.set('dev:rooms:waiting', ['cooldown', 'kicked', 'open']);
    addLiveRoom(redis, 'cooldown');
    addLiveRoom(redis, 'kicked');
    addLiveRoom(redis, 'open');
    redis.ttls.set('dev:room-rejoin:cooldown:1', 30_000);
    redis.values.set('dev:operation:room-kicked:kicked:1', '1');
    const service = makeService(redis);
    const commands: ControlCommand[] = [];
    (service as any).sendCommand = async (_serverId: string, command: ControlCommand): Promise<ControlReply> => {
        commands.push(command);
        return {
            v: CONTROL_VERSION,
            requestId: command.requestId,
            serverId: 'game-a',
            ok: true,
            code: null,
            payload: { wsPath: '/game/game-a', ticket: 'ticket', expiresAt: 1 },
        };
    };

    const result = await service.quickJoin(1);

    assert.deepEqual(result, { roomId: 'open', roomCode: 'ABC234', wsPath: '/game/game-a', ticket: 'ticket', expiresAt: 1 });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, CommandType.ReserveJoin);
    assert.equal((commands[0].payload as { roomId: string }).roomId, 'open');
});

test('guest quick join is limited by both actor id and request IP', async () => {
    const redis = new FakeRedis();
    redis.sorted.set('dev:rooms:waiting', ['open']);
    addLiveRoom(redis, 'open');
    const service = makeService(redis);
    let command: ControlCommand | undefined;
    (service as any).sendCommand = async (_serverId: string, value: ControlCommand): Promise<ControlReply> => {
        command = value;
        return {
            v: CONTROL_VERSION, requestId: value.requestId, serverId: 'game-a', ok: true, code: null,
            payload: { wsPath: '/game/game-a', ticket: 'ticket', expiresAt: 1 },
        };
    };
    const guest = {
        id: 'g:11111111-1111-4111-8111-111111111111',
        nickname: 'Guest_7KPW2M',
        guest: true,
    } as const;

    await service.quickJoin(guest, '203.0.113.9');

    assert.equal(redis.values.get(`dev:operation:room-join-rate:actor:${guest.id}`), '1');
    assert.equal(redis.values.get('dev:operation:room-join-rate:ip:hmac:203.0.113.9'), '1');
    assert.equal((command!.payload as { userId: string }).userId, guest.id);
});

test('a reply resolves only the pending request from its expected server', async () => {
    const redis = new FakeRedis();
    const service = makeService(redis);
    const command: ControlCommand = {
        v: CONTROL_VERSION,
        requestId: 'correlated-request',
        type: CommandType.ReserveJoin,
        issuedAt: 1,
        deadlineAt: 2,
        replyTo: 'dev:matching-server:replies:test',
        payload: { roomId: 'room', userId: 1, nickname: 'Alice', password: null },
    };
    const replyPromise = (service as any).sendCommand('expected-server', command) as Promise<ControlReply>;
    await Promise.resolve();
    let settled = false;
    void replyPromise.then(() => { settled = true; });

    (service as any).resolvePendingReply({
        v: CONTROL_VERSION,
        requestId: command.requestId,
        serverId: 'wrong-server',
        ok: true,
        code: null,
        payload: {},
    } satisfies ControlReply);
    await Promise.resolve();
    assert.equal(settled, false);

    const expectedReply: ControlReply = {
        v: CONTROL_VERSION,
        requestId: command.requestId,
        serverId: 'expected-server',
        ok: true,
        code: null,
        payload: {},
    };
    (service as any).resolvePendingReply(expectedReply);
    assert.deepEqual(await replyPromise, expectedReply);
    service.onModuleDestroy();
});

test('a pending active-room reservation is retryable and never masquerades as an assignment', async () => {
    const redis = new FakeRedis();
    redis.values.set('dev:user:1:active-room', JSON.stringify({ state: 'reservation', requestId: 'pending' }));
    const service = makeService(redis);
    await assert.rejects((service as any).existingRoomResponse(1), (error: unknown) => {
        assert.ok(error instanceof ServiceUnavailableException);
        assert.deepEqual(error.getResponse(), { code: 'ACTIVE_ROOM_PENDING', retryable: true });
        return true;
    });
});

test('join command uncertainty rolls back assignment and active-room reservation immediately', async () => {
    const redis = new FakeRedis();
    addLiveRoom(redis, 'room-id');
    const service = makeService(redis);
    (service as any).sendCommand = async () => {
        throw new ServiceUnavailableException({ code: 'COMMAND_TIMEOUT', retryable: true, outcome: 'unknown' });
    };
    await assert.rejects(service.join(1, 'room-id'), ServiceUnavailableException);
    assert.equal(redis.values.has('dev:user:1:active-room'), false);
});

test('six-character room code resolves to the internal room id', async () => {
    const redis = new FakeRedis();
    const roomId = '11111111-1111-4111-8111-111111111111';
    redis.values.set('dev:room-code:ABC234', roomId);
    addLiveRoom(redis, roomId);
    const service = makeService(redis);
    (service as any).sendCommand = async (_serverId: string, command: ControlCommand): Promise<ControlReply> => ({
        v: CONTROL_VERSION, requestId: command.requestId, serverId: 'game-a', ok: true, code: null,
        payload: { wsPath: '/game-ws/game-a', ticket: 'ticket', expiresAt: 1 },
    });
    const result = await service.joinByCode(1, 'abc234');
    assert.equal('alreadyAssigned' in result, false);
    if ('alreadyAssigned' in result) throw new Error('unexpected existing assignment');
    assert.equal(result.roomId, roomId);
    assert.equal(result.roomCode, 'ABC234');
});

test('계정 사용자의 전적이 자리 예약 명령에 실린다', async () => {
    const redis = new FakeRedis();
    addLiveRoom(redis, 'room-1');
    // 인게임 서버는 DB를 모른다. 여기서 안 실어 보내면 로비 카드가 영원히 비어 있다.
    const service = makeService(redis, { games: 3, wins: 2, sw_try: 3, sw_su: 2 });
    let command: ControlCommand | undefined;
    (service as any).sendCommand = async (_serverId: string, value: ControlCommand): Promise<ControlReply> => {
        command = value;
        return {
            v: CONTROL_VERSION, requestId: value.requestId, serverId: 'game-a', ok: true, code: null,
            payload: { wsPath: '/game/game-a', ticket: 'ticket', expiresAt: 1 },
        };
    };

    await service.join(1, 'room-1');

    assert.deepEqual((command!.payload as { stats: unknown }).stats, {
        games: 3,
        wins: 2,
        winRate: 66.7,
        switchSuccessRate: 66.7,
    });
});

test('게스트는 전적 없이 예약한다', async () => {
    const redis = new FakeRedis();
    addLiveRoom(redis, 'room-1');
    const service = makeService(redis, { games: 3, wins: 2, sw_try: 3, sw_su: 2 });
    let command: ControlCommand | undefined;
    (service as any).sendCommand = async (_serverId: string, value: ControlCommand): Promise<ControlReply> => {
        command = value;
        return {
            v: CONTROL_VERSION, requestId: value.requestId, serverId: 'game-a', ok: true, code: null,
            payload: { wsPath: '/game/game-a', ticket: 'ticket', expiresAt: 1 },
        };
    };

    await service.join({
        id: 'g:11111111-1111-4111-8111-111111111111',
        nickname: 'Guest_7KPW2M',
        guest: true,
    }, 'room-1', undefined, '203.0.113.9');

    assert.equal((command!.payload as { stats: unknown }).stats, null);
});

/** heartbeat 하나를 Redis에 심는다. 배정이 이 값을 보고 서버를 고른다. */
function addServer(redis: FakeRedis, serverId: string, overrides: Record<string, unknown> = {}): void {
    redis.values.set(`dev:game-server:${serverId}`, JSON.stringify({
        serverId,
        protocolVersion: PROTOCOL_VERSION,
        waitingRooms: 0,
        playingRooms: 0,
        connections: 0,
        loopLagMs: 0,
        draining: false,
        internalAddress: `http://127.0.0.1:4000`,
        maxRooms: 100,
        updatedAt: Date.now(),
        ...overrides,
    }));
    const alive = redis.sorted.get('dev:game-servers:alive') ?? [];
    alive.push(serverId);
    redis.sorted.set('dev:game-servers:alive', alive);
}

test('가득 찬 서버에는 방을 배정하지 않는다', async () => {
    // 후보에 두면 가장 한가한 축에 들 때 골라 놓고 SERVER_FULL을 돌려받는다. 사용자에게는
    // 그냥 실패다 — 상한이 뜻을 가지려면 배정하는 쪽이 그 값을 봐야 한다.
    const redis = new FakeRedis();
    addServer(redis, 'game-full', { waitingRooms: 100, maxRooms: 100 });
    addServer(redis, 'game-free', { waitingRooms: 40, maxRooms: 100 });
    const service = makeService(redis);

    const chosen = await (service as any).selectServer();
    assert.equal(chosen.serverId, 'game-free', '가득 찬 서버를 골랐다');
});

test('maxRooms를 안 싣는 서버는 상한이 없는 것으로 본다', async () => {
    // 예전 판 heartbeat가 섞여 있을 수 있다. 모르는 값 때문에 멀쩡한 서버를 빼면 배정이 막힌다.
    const redis = new FakeRedis();
    addServer(redis, 'game-old', { waitingRooms: 500, maxRooms: undefined });
    const service = makeService(redis);

    const chosen = await (service as any).selectServer();
    assert.equal(chosen.serverId, 'game-old');
});

test('전부 가득 차면 배정할 서버가 없다', async () => {
    const redis = new FakeRedis();
    addServer(redis, 'game-full', { playingRooms: 100, maxRooms: 100 });
    const service = makeService(redis);

    await assert.rejects(() => (service as any).selectServer());
});
