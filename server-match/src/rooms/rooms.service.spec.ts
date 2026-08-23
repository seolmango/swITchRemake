import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictException } from '@nestjs/common';
import { CONTROL_VERSION, CommandType, ControlErrorCode, type ControlCommand, type ControlReply } from 'shared';
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

function makeService(redis = new FakeRedis()): RoomsService {
    const db = {
        select: () => ({
            from: () => ({
                where: async () => [{ id: 1, nickname: 'Alice', accountStatus: 'ACTIVE' }],
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

    assert.deepEqual(result, { wsPath: '/game/game-a', ticket: 'ticket', expiresAt: 1 });
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
