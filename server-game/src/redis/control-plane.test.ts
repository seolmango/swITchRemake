import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    CONTROL_VERSION,
    CommandType,
    HEARTBEAT_TTL_MS,
    MATCH_RESULT_VERSION,
    RoomState,
    makeKeys,
    type ActorId,
    type ControlCommand,
    type ControlReply,
    type MatchResultMessage,
} from 'shared';
import { InMemoryTicketStore } from '../gateway/ticket-store';
import { RoomManager } from '../rooms/room-manager';
import type { RoomLifecyclePort } from '../rooms/room';
import type { Connection } from '../transport/game-transport';
import { CommandConsumer } from './command-consumer';
import { CONTROL_STREAM_FIELDS, decodeCommand } from './control-codec';
import { GameRegistry } from './registry';
import type { RedisPort, StreamEntry } from './redis-client';
import { RESULT_STREAM_FIELD, ResultOutbox } from './result-outbox';

class FakeRedis implements RedisPort {
    ready = true;
    failXAdd = false;
    blockSet: Promise<void> | null = null;
    setCalls = 0;
    readonly values = new Map<string, string>();
    readonly ttls = new Map<string, number>();
    readonly sorted = new Map<string, Map<string, number>>();
    readonly fresh: StreamEntry[] = [];
    readonly reclaimed: StreamEntry[] = [];
    readonly added: { stream: string; field: string; value: string; maxLength: number }[] = [];
    readonly acknowledged: string[] = [];
    readonly log: string[] = [];

    async connect(): Promise<void> { this.ready = true; }
    async close(): Promise<void> { this.ready = false; }
    isReady(): boolean { return this.ready; }
    async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
    async setPx(key: string, value: string, ttlMs: number): Promise<void> {
        if (!this.ready) throw new Error('redis unavailable');
        this.setCalls += 1;
        if (this.blockSet !== null) await this.blockSet;
        this.values.set(key, value);
        this.ttls.set(key, ttlMs);
        this.log.push(`set:${key}`);
    }
    async setPxIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
        if (!this.ready) throw new Error('redis unavailable');
        if (this.values.has(key)) return false;
        await this.setPx(key, value, ttlMs);
        return true;
    }
    async delete(key: string): Promise<void> {
        if (!this.ready) throw new Error('redis unavailable');
        this.values.delete(key);
        this.ttls.delete(key);
        this.log.push(`del:${key}`);
    }
    async compareAndDelete(key: string, expectedValue: string): Promise<boolean> {
        if (!this.ready) throw new Error('redis unavailable');
        if (this.values.get(key) !== expectedValue) return false;
        this.values.delete(key);
        this.ttls.delete(key);
        this.log.push(`compare-del:${key}`);
        return true;
    }
    async compareAndExpire(key: string, expectedValue: string, ttlMs: number): Promise<boolean> {
        if (!this.ready) throw new Error('redis unavailable');
        this.log.push(`compare-expire:${key}`);
        if (this.values.get(key) !== expectedValue) return false;
        this.ttls.set(key, ttlMs);
        return true;
    }
    async zAdd(key: string, score: number, member: string): Promise<void> {
        if (!this.ready) throw new Error('redis unavailable');
        let values = this.sorted.get(key);
        if (values === undefined) {
            values = new Map();
            this.sorted.set(key, values);
        }
        values.set(member, score);
        this.log.push(`zadd:${key}:${member}`);
    }
    async zRemove(key: string, member: string): Promise<void> {
        if (!this.ready) throw new Error('redis unavailable');
        this.sorted.get(key)?.delete(member);
        this.log.push(`zrem:${key}:${member}`);
    }
    async zRemoveByScore(key: string, min: number, max: number): Promise<number> {
        if (!this.ready) throw new Error('redis unavailable');
        let removed = 0;
        for (const [member, score] of this.sorted.get(key) ?? []) {
            if (score >= min && score <= max) {
                this.sorted.get(key)?.delete(member);
                removed += 1;
            }
        }
        this.log.push(`zremrange:${key}`);
        return removed;
    }
    async xGroupCreate(stream: string, group: string, startId: string): Promise<void> {
        if (!this.ready) throw new Error('redis unavailable');
        this.log.push(`xgroup:${stream}:${group}:${startId}`);
    }
    async xReadGroup(_stream: string, _group: string, _consumer: string, _blockMs: number, count: number): Promise<StreamEntry[]> {
        if (!this.ready) throw new Error('redis unavailable');
        this.log.push('xreadgroup');
        return this.fresh.splice(0, count);
    }
    async xAutoClaim(_stream: string, _group: string, _consumer: string, _minIdleMs: number, count: number): Promise<StreamEntry[]> {
        if (!this.ready) throw new Error('redis unavailable');
        this.log.push('xautoclaim');
        return this.reclaimed.splice(0, count);
    }
    async xAdd(stream: string, field: string, value: string, maxLength: number): Promise<string> {
        if (!this.ready || this.failXAdd) throw new Error('xadd failed');
        this.added.push({ stream, field, value, maxLength });
        this.log.push(`xadd:${stream}`);
        return `${this.added.length}-0`;
    }
    async xAck(stream: string, group: string, entryId: string): Promise<void> {
        if (!this.ready) throw new Error('redis unavailable');
        this.acknowledged.push(entryId);
        this.log.push(`xack:${stream}:${group}:${entryId}`);
    }
}

class FakeConnection implements Connection {
    readonly lobbyStats = null;
    public constructor(
        readonly id: number,
        readonly userId: ActorId,
        readonly nickname: string,
        readonly roomId: string,
        readonly playerId: number,
        readonly resume = false,
        readonly isGuest = false,
    ) {}
    sendJson(_message: Parameters<Connection['sendJson']>[0]): void {}
    sendBinary(_payload: ArrayBuffer): void {}
    bufferedBytes(): number { return 0; }
    close(_code: number, _reason: string): void {}
}

const lifecycle: RoomLifecyclePort = {
    startGame: (snapshot) => ({ startTick: 1, taggerId: snapshot.players[0]!.playerId }),
    connectionChanged: () => undefined,
    participantTimedOut: () => undefined,
    participantRemoved: () => undefined,
        stopRoom: () => undefined,
};

function harness() {
    let now = 1_000;
    const redis = new FakeRedis();
    const keys = makeKeys('test');
    const rooms = new RoomManager({
        lifecycle,
        isKnownMap: (mapId) => mapId === 'map',
        getServerTick: () => 0,
        violationSink: () => undefined,
        now: () => now,
    });
    const tickets = new InMemoryTicketStore(() => now);
    const registry = new GameRegistry({
        redis,
        keys,
        rooms,
        heartbeat: {
            serverId: 'game-1',
            buildVersion: 'build',
            protocolVersion: 2,
            rulesVersion: 'rules',
            mapBundleHash: 'hash',
            connectionCount: () => 2,
            loopLagMs: () => 3,
            isDraining: () => false,
        },
        now: () => now,
    });
    let nextRoomId = 1;
    const drainCalls: number[] = [];
    const makeConsumer = (consumerId: string) => new CommandConsumer({
        redis,
        keys,
        serverId: 'game-1',
        wsPath: '/game/game-1',
        consumerId,
        rooms,
        tickets,
        registry,
        isDraining: () => false,
        beginDrain: () => { drainCalls.push(now); },
        now: () => now,
        roomIdFactory: () => `room-${nextRoomId++}`,
        readBlockMs: 0,
    });
    const consumer = makeConsumer('consumer-1');
    return {
        redis, keys, rooms, tickets, registry, consumer, makeConsumer, drainCalls,
        getNow: () => now, setNow: (value: number) => { now = value; },
    };
}

const requestIds = new Map<string, string>();
function uuidFor(label: string): string {
    const existing = requestIds.get(label);
    if (existing !== undefined) return existing;
    const suffix = (requestIds.size + 1).toString(16).padStart(12, '0');
    const value = `00000000-0000-4000-8000-${suffix}`;
    requestIds.set(label, value);
    return value;
}

/** 보낸 인스턴스 전용 응답 stream. 답이 여기로 가는지가 확장 시 지연을 가른다. */
const REPLY_STREAM = 'dev:matching-server:replies:matching-test';

function command(requestId: string, type: string, payload: unknown, deadlineAt = 5_000): ControlCommand {
    return {
        v: CONTROL_VERSION,
        requestId: uuidFor(requestId),
        type: type as ControlCommand['type'],
        issuedAt: 1_000,
        deadlineAt,
        replyTo: REPLY_STREAM,
        payload,
    };
}

function streamEntry(id: string, value: ControlCommand): StreamEntry {
    return { id, fields: { [CONTROL_STREAM_FIELDS.command]: JSON.stringify(value) } };
}

function latestReply(redis: FakeRedis): ControlReply {
    const raw = redis.added.at(-1);
    assert.equal(raw?.field, CONTROL_STREAM_FIELDS.reply);
    return JSON.parse(raw!.value) as ControlReply;
}

function createCommand(requestId = 'create-1'): ControlCommand {
    return command(requestId, CommandType.CreateRoom, {
        matchId: 'match-1',
        roomCode: 'ABC234',
        roomName: 'room',
        password: null,
        ownerUserId: 1,
        ownerNickname: 'owner',
        capacity: 8,
        mapId: 'map',
    });
}

test('command reply를 XADD한 뒤에만 XACK하고 duplicate는 같은 결과를 replay한다', async () => {
    const h = harness();
    const create = createCommand();
    h.redis.fresh.push(streamEntry('1-0', create));
    assert.equal(await h.consumer.pollOnce(), 1);
    const firstReply = latestReply(h.redis);
    assert.equal(firstReply.ok, true);
    assert.equal(h.rooms.size, 1);
    assert.ok(h.redis.log.indexOf(`xadd:${h.keys.replies()}`) < h.redis.log.findIndex((value) => value.includes('xack:')));

    h.redis.fresh.push(streamEntry('2-0', create));
    await h.makeConsumer('consumer-after-restart').pollOnce();
    const duplicateReply = latestReply(h.redis);
    assert.deepEqual(duplicateReply, firstReply);
    assert.equal(h.rooms.size, 1, '같은 requestId가 방과 티켓을 다시 만들면 안 된다');
});

test('deadline이 지난 명령은 부수 효과 없이 EXPIRED를 저장하고 응답한다', async () => {
    const h = harness();
    const expired = createCommand('expired');
    h.redis.fresh.push(streamEntry('1-0', expired));
    h.setNow(5_001);
    await h.consumer.pollOnce();
    assert.equal(latestReply(h.redis).code, 'EXPIRED');
    assert.equal(h.rooms.size, 0);
    assert.notEqual(h.redis.values.get(h.keys.operation(expired.requestId)), undefined);
});

test('XAUTOCLAIM으로 회수하고 reply 실패 시 ack하지 않은 채 local operation으로 복구한다', async () => {
    const h = harness();
    const create = createCommand('reclaimed');
    h.redis.reclaimed.push(streamEntry('9-0', create));
    h.redis.failXAdd = true;
    await assert.rejects(h.consumer.pollOnce(), /xadd failed/);
    assert.equal(h.rooms.size, 1, 'reply 장애가 이미 진행 중인 로컬 방을 지우면 안 된다');
    assert.deepEqual(h.redis.acknowledged, []);

    h.setNow(62_000);
    h.redis.values.delete(h.keys.operation(create.requestId));
    h.redis.ttls.delete(h.keys.operation(create.requestId));

    h.redis.failXAdd = false;
    h.redis.reclaimed.push(streamEntry('9-0', create));
    await h.consumer.pollOnce();
    assert.deepEqual(h.redis.acknowledged, ['9-0']);
    assert.equal(h.rooms.size, 1, 'reclaim이 명령 부수 효과를 반복하면 안 된다');
    assert.equal(h.redis.log.includes('xautoclaim'), true);
    assert.equal(h.redis.ttls.get(h.keys.operation(create.requestId)), 60_000,
        'ACK 전인 local 결과는 60초가 지나도 pin하고 Redis TTL을 재설정한다');
});

test('command codec가 wire 계약과 입력 상한을 강제한다', () => {
    const valid = createCommand('codec-valid');
    assert.deepEqual(decodeCommand(JSON.stringify(valid)), valid);
    assert.throws(() => decodeCommand(JSON.stringify({ ...valid, requestId: 'room-kicked:x:1' })), /Malformed/);
    assert.throws(() => decodeCommand(JSON.stringify({ ...valid, deadlineAt: valid.issuedAt - 1 })), /Malformed/);
    assert.throws(() => decodeCommand(JSON.stringify({
        ...valid,
        payload: { ...valid.payload as Record<string, unknown>, ownerUserId: '1' },
    })), /Malformed/);
    assert.throws(() => decodeCommand(JSON.stringify({
        ...valid,
        payload: { ...valid.payload as Record<string, unknown>, roomName: 'x'.repeat(21) },
    })), /Malformed/);
    assert.throws(() => decodeCommand(JSON.stringify({
        ...valid,
        payload: { ...valid.payload as Record<string, unknown>, capacity: 9 },
    })), /Malformed/);
    assert.doesNotThrow(() => decodeCommand(JSON.stringify({
        ...valid,
        payload: {
            ...valid.payload as Record<string, unknown>,
            ownerUserId: 'g:00000000-0000-4000-8000-000000000001',
        },
    })));
});

test('JOIN/RESUME/RELEASE/KICK 명령이 같은 RoomManager와 TicketStore를 사용한다', async () => {
    const h = harness();
    const send = async (id: string, value: ControlCommand): Promise<ControlReply> => {
        h.redis.fresh.push(streamEntry(id, value));
        await h.consumer.pollOnce();
        return latestReply(h.redis);
    };
    const connectGrant = (ticket: string, userId: number, id: number, resume = false): FakeConnection => {
        const admitted = h.tickets.consumeWhen(ticket, (reservation) => h.rooms.admitReservation(reservation));
        assert.notEqual(admitted, null);
        const connection = new FakeConnection(id, userId, userId === 1 ? 'owner' : `p${userId}`, 'room-1', admitted!.playerId, resume);
        h.rooms.onConnect(connection);
        return connection;
    };

    const created = await send('1-0', createCommand()) as ControlReply<{ roomId: string; ticket: string }>;
    const owner = connectGrant(created.payload!.ticket, 1, 1);
    const joined = await send('2-0', command('join-2', CommandType.ReserveJoin, {
        roomId: 'room-1', userId: 2, nickname: 'p2', password: null,
    })) as ControlReply<{ ticket: string }>;
    assert.equal(joined.ok, true);
    connectGrant(joined.payload!.ticket, 2, 2);

    h.rooms.onDisconnect(owner, 'network');
    const resume = await send('3-0', command('resume-1', CommandType.ReserveResume, { roomId: 'room-1', userId: 1 })) as ControlReply<{ ticket: string }>;
    assert.equal(resume.ok, true);
    connectGrant(resume.payload!.ticket, 1, 3, true);

    h.redis.values.set(h.keys.userActiveRoom(2), JSON.stringify({ state: 'assigned', roomId: 'room-1' }));
    const released = await send('4-0', command('release-2', CommandType.ReleaseSeat, { roomId: 'room-1', userId: 2 }));
    assert.equal(released.ok, true);
    await h.registry.publish();
    assert.equal(h.redis.values.get(h.keys.roomRejoin('room-1', 2)), '1');
    const blocked = await send('5-0', command('rejoin-2', CommandType.ReserveJoin, {
        roomId: 'room-1', userId: 2, nickname: 'p2', password: null,
    }));
    assert.equal(blocked.code, 'REJOIN_COOLDOWN');

    const third = await send('6-0', command('join-3', CommandType.ReserveJoin, {
        roomId: 'room-1', userId: 3, nickname: 'p3', password: null,
    })) as ControlReply<{ ticket: string }>;
    connectGrant(third.payload!.ticket, 3, 4);
    h.redis.values.set(h.keys.userActiveRoom(3), JSON.stringify({ state: 'assigned', roomId: 'room-1' }));
    const kicked = await send('7-0', command('kick-3', CommandType.KickUser, {
        roomId: 'room-1', userId: 3, reason: 'moderation',
    }));
    assert.equal(kicked.ok, true);
    await h.registry.publish();
    assert.equal(h.redis.values.get(h.keys.operation('room-kicked:room-1:3')), '1');
});

test('registry가 heartbeat/room TTL, waiting index, active-room lease와 stale cleanup을 갱신한다', async () => {
    const h = harness();
    h.redis.fresh.push(streamEntry('1-0', createCommand()));
    await h.consumer.pollOnce();
    const reply = latestReply(h.redis) as ControlReply<{ roomId: string; ticket: string }>;
    const grant = reply.payload!;
    const admitted = h.tickets.consumeWhen(grant.ticket, (reservation) => h.rooms.admitReservation(reservation));
    assert.notEqual(admitted, null);
    h.rooms.onConnect(new FakeConnection(1, 1, 'owner', grant.roomId, admitted!.playerId));
    h.redis.values.set(h.keys.userActiveRoom(1), JSON.stringify({
        state: 'assigned', requestId: createCommand().requestId, roomId: grant.roomId, serverId: 'game-1',
    }));
    h.redis.sorted.set(h.keys.gameServersAlive(), new Map([['dead-server', -10_000]]));
    h.redis.sorted.set(h.keys.roomsWaiting(), new Map([['dead-room', -10_000]]));

    assert.equal(await h.registry.publish(), true);
    assert.equal(h.redis.ttls.get(h.keys.gameServer('game-1')), HEARTBEAT_TTL_MS);
    assert.equal(h.redis.ttls.get(h.keys.room(grant.roomId)), HEARTBEAT_TTL_MS);
    assert.equal(h.redis.sorted.get(h.keys.roomsWaiting())?.has(grant.roomId), true);
    assert.equal(h.redis.sorted.get(h.keys.roomsWaiting())?.has('dead-room'), false);
    assert.equal(h.redis.sorted.get(h.keys.gameServersAlive())?.has('dead-server'), false);
    assert.equal(h.redis.ttls.get(h.keys.userActiveRoom(1)), 30_000);
    const projection = JSON.parse(h.redis.values.get(h.keys.room(grant.roomId))!) as {
        state: string;
        status: string;
        serverId: string;
        ownerName: string;
        playerCount: number;
    };
    assert.equal(projection.state, RoomState.Waiting);
    assert.equal(projection.status, RoomState.Waiting);
    assert.equal(projection.serverId, 'game-1');
    assert.equal(projection.ownerName, 'owner');
    assert.equal(projection.playerCount, 1);

    h.redis.values.delete(h.keys.userActiveRoom(1));
    await h.registry.publish();
    const restoredClaim = JSON.parse(h.redis.values.get(h.keys.userActiveRoom(1))!) as { state: string; roomId: string };
    assert.equal(restoredClaim.state, 'assigned');
    assert.equal(restoredClaim.roomId, grant.roomId, 'Redis 복구 뒤 실제 입장한 seat의 active claim을 복원한다');

    const newerClaim = JSON.stringify({
        state: 'assigned', requestId: uuidFor('newer-room'), roomId: 'new-room', serverId: 'game-2',
    });
    h.redis.values.set(h.keys.userActiveRoom(1), newerClaim);
    h.redis.ttls.set(h.keys.userActiveRoom(1), 123);
    await h.registry.publish();
    assert.equal(h.redis.values.get(h.keys.userActiveRoom(1)), newerClaim);
    assert.equal(h.redis.ttls.get(h.keys.userActiveRoom(1)), 123,
        '이전 방 heartbeat가 다른 방의 새 claim TTL을 연장하면 안 된다');

    h.rooms.releaseSeat(grant.roomId, 1);
    await h.registry.publish();
    assert.equal(h.redis.values.has(h.keys.room(grant.roomId)), false);
    assert.equal(h.redis.sorted.get(h.keys.roomsWaiting())?.has(grant.roomId), false);
    assert.equal(h.redis.values.get(h.keys.userActiveRoom(1)), newerClaim,
        '이전 방 종료 정리가 다른 방의 새 claim을 지우면 안 된다');
});

test('room-directory changes publish immediately, coalesce while in flight, and keep a trailing publish', async () => {
    const h = harness();
    let releaseSet!: () => void;
    h.redis.blockSet = new Promise<void>((resolve) => { releaseSet = resolve; });

    h.registry.requestPublish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.redis.setCalls, 1, 'the first change must begin publishing without a debounce delay');

    for (let index = 0; index < 8; index += 1) h.registry.requestPublish();
    releaseSet();
    h.redis.blockSet = null;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(h.redis.setCalls, 2, 'many in-flight changes must become one trailing publish');
});

test('a live game-server heartbeat claims its GAME_SERVER_ID, while an expired key does not block restart', async () => {
    const h = harness();
    assert.equal(await h.registry.claimServerId(), true);

    const duplicate = new GameRegistry({
        redis: h.redis,
        keys: h.keys,
        rooms: h.rooms,
        heartbeat: {
            serverId: 'game-1', buildVersion: 'build', protocolVersion: 2, rulesVersion: 'rules', mapBundleHash: 'hash',
            connectionCount: () => 0, loopLagMs: () => 0, isDraining: () => false,
        },
    });
    assert.equal(await duplicate.claimServerId(), false, 'a live heartbeat rejects a duplicate server ID');

    await h.redis.delete(h.keys.gameServer('game-1'));
    assert.equal(await duplicate.claimServerId(), true, 'an expired heartbeat no longer blocks a restart');
});

test('ticket admit 전 hold도 active-room lease를 유지하며 추적에서 제거하지 않는다', async () => {
    const h = harness();
    const create = createCommand();
    h.redis.fresh.push(streamEntry('1-0', create));
    await h.consumer.pollOnce();
    const pendingClaim = JSON.stringify({ state: 'reservation', requestId: create.requestId });
    h.redis.values.set(h.keys.userActiveRoom(1), pendingClaim);

    await h.registry.publish();
    assert.equal(h.rooms.get('room-1')?.reservedPlayerId(1), 1);
    assert.equal(h.redis.values.get(h.keys.userActiveRoom(1)), pendingClaim);
    assert.equal(h.redis.ttls.get(h.keys.userActiveRoom(1)), 30_000);
});

test('malformed command도 INTERNAL reply를 기록한 다음 ack해 poison reclaim을 막는다', async () => {
    const h = harness();
    h.redis.fresh.push({ id: 'bad-1', fields: { command: '{"requestId":"broken"}' } });
    await h.consumer.pollOnce();
    assert.equal(latestReply(h.redis).requestId, 'invalid:game-1:bad-1');
    assert.equal(latestReply(h.redis).code, 'INTERNAL');
    assert.deepEqual(h.redis.acknowledged, ['bad-1']);
    assert.ok(h.redis.log.indexOf(`xadd:${h.keys.replies()}`) < h.redis.log.findIndex((value) => value.includes('xack:')));

    h.redis.fresh.push({ id: 'bad-2', fields: { command: JSON.stringify({ requestId: 'x'.repeat(100_000) }) } });
    await h.consumer.pollOnce();
    assert.equal(latestReply(h.redis).requestId, 'invalid:game-1:bad-2',
        'malformed payload의 임의 문자열을 reply stream에 증폭하면 안 된다');
});

test('답은 보낸 인스턴스가 적어 준 stream으로만 간다', async () => {
    // 공용 stream에 넣으면 다른 매칭 서버 인스턴스가 소비자 그룹에서 가져가 ack해 버린다.
    // 원 요청자는 아무것도 못 받고 2초 복구 타이머까지 기다린다 — 확장하는 순간 모든 방 생성이 2초가 된다.
    const h = harness();
    h.redis.fresh.push(streamEntry('create-ok', createCommand()));
    await h.consumer.pollOnce();

    const replies = h.redis.added.filter((entry) => entry.field === CONTROL_STREAM_FIELDS.reply);
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.stream, REPLY_STREAM);
    assert.equal(replies.some((entry) => entry.stream === h.keys.replies()), false);
});

test('주소를 읽을 수 없는 깨진 명령의 답만 공용 사서함으로 간다', async () => {
    const h = harness();
    // replyTo가 살아 있으면 명령이 깨졌어도 원 요청자가 즉시 실패를 받는다.
    h.redis.fresh.push({ id: 'bad-a', fields: { command: JSON.stringify({ requestId: 'broken', replyTo: REPLY_STREAM }) } });
    await h.consumer.pollOnce();
    assert.equal(h.redis.added.at(-1)?.stream, REPLY_STREAM);

    // 주소까지 못 읽으면 갈 곳이 없다. 원 요청자는 어차피 상관관계를 만들 수 없어 타임아웃으로 복구한다.
    h.redis.fresh.push({ id: 'bad-b', fields: { command: '{"requestId":"broken"}' } });
    await h.consumer.pollOnce();
    assert.equal(h.redis.added.at(-1)?.stream, h.keys.replies());
});

test('DRAIN_SERVER 명령이 이 서버를 재우고 남은 방 수를 알려 준다', async () => {
    // 신호가 아니라 제어 평면으로 받는다. Windows에는 SIGTERM이 없어 Node가 핸들러를 부르지
    // 않고 프로세스를 즉시 죽이고, 감독자가 같은 기계에 있다는 보장도 없다.
    const h = harness();
    h.redis.fresh.push(streamEntry('create-for-drain', createCommand()));
    await h.consumer.pollOnce();

    h.redis.fresh.push(streamEntry('drain-1', command('drain-1', CommandType.DrainServer, { serverId: 'game-1' })));
    await h.consumer.pollOnce();

    const reply = latestReply(h.redis);
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.payload, { remainingRooms: 1 });
    assert.deepEqual(h.drainCalls.length, 1);
});

test('남의 serverId로 온 DRAIN_SERVER는 거절한다', async () => {
    // 스트림을 잘못 짚으면 엉뚱한 서버가 잠든다. 대상을 적게 하고 다르면 안 받는다.
    const h = harness();
    h.redis.fresh.push(streamEntry('drain-other', command('drain-other', CommandType.DrainServer, { serverId: 'game-9' })));
    await h.consumer.pollOnce();

    assert.equal(latestReply(h.redis).ok, false);
    assert.deepEqual(h.drainCalls, []);
});

test('퇴장 cooldown과 강퇴 marker는 A1이 조회하는 makeKeys 형태로 기록된다', async () => {
    const h = harness();
    const newerClaim = JSON.stringify({ state: 'assigned', roomId: 'new-room' });
    h.redis.values.set(h.keys.userActiveRoom(2), newerClaim);
    h.registry.trackSeat('room-x', 2, 'release-request');
    h.registry.noteReleased('room-x', 2, true);
    h.registry.noteReleased('room-x', 2, false);
    h.registry.noteReleased('room-x', 3, true);
    h.registry.noteKicked('room-x', 3);
    h.registry.noteReleased('room-x', 3, false);
    await h.registry.publish();
    assert.equal(h.redis.values.get(h.keys.roomRejoin('room-x', 2)), '1');
    assert.equal(h.redis.ttls.get(h.keys.roomRejoin('room-x', 2)), 60_000);
    assert.equal(h.redis.values.get(h.keys.operation('room-kicked:room-x:3')), '1');
    assert.equal(h.redis.values.get(h.keys.roomRejoin('room-x', 3)), '1',
        '중복 release가 이미 관찰한 cooldown/kick 정보를 약화하면 안 된다');
    assert.equal(h.redis.values.get(h.keys.userActiveRoom(2)), newerClaim, '이전 방 정리가 새 방의 active claim을 지우면 안 된다');
});

function result(matchId: string): MatchResultMessage {
    return {
        v: MATCH_RESULT_VERSION,
        matchId,
        roomId: 'room',
        serverId: 'game-1',
        mapId: 'map',
        startedAt: 1,
        endedAt: 2,
        durationTicks: 1,
        buildId: 'build',
        protocolVersion: 2,
        rulesVersion: 'rules',
        mapBundleHash: 'hash',
        visibilityCoreVersion: 1,
        winnerPlayerIds: [1, 2],
        replay: null,
        players: [],
    };
}

test('Redis 장애 중 result outbox가 순서를 보존하고 복구 후 MAXLEN stream으로 flush한다', async () => {
    const redis = new FakeRedis();
    const outbox = new ResultOutbox({ redis, keys: makeKeys('test'), maxEntries: 2 });
    redis.ready = false;
    outbox.enqueue(result('a'));
    outbox.enqueue(result('b'));
    assert.equal(outbox.canStartNewGame(), false);
    assert.equal(await outbox.flush(), 0);
    assert.equal(outbox.size, 2);
    assert.throws(() => outbox.enqueue(result('c')), /capacity exceeded/);

    redis.ready = true;
    redis.failXAdd = true;
    assert.equal(await outbox.flush(), 0);
    assert.equal(outbox.size, 2);
    redis.failXAdd = false;
    assert.equal(await outbox.flush(), 2);
    assert.equal(outbox.size, 0);
    assert.equal(outbox.canStartNewGame(), true);
    assert.deepEqual(redis.added.map((entry) => ({ field: entry.field, matchId: (JSON.parse(entry.value) as MatchResultMessage).matchId })), [
        { field: RESULT_STREAM_FIELD, matchId: 'a' },
        { field: RESULT_STREAM_FIELD, matchId: 'b' },
    ]);
});
