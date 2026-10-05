import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RoomMode, SkillId, PROTOCOL_VERSION, makeKeys, type ActorId } from 'shared';
import { handOffWaitingRooms } from '../rooms/hand-off';
import { RoomManager } from '../rooms/room-manager';
import type { RoomLifecyclePort } from '../rooms/room';
import { GameRegistry } from './registry';
import type { AtomicReplacement, RedisPort, StreamEntry } from './redis-client';

class FakeRedis implements RedisPort {
    readonly values = new Map<string, string>();
    readonly ttls = new Map<string, number>();
    readonly compareDeleted: string[] = [];

    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    isReady(): boolean { return true; }
    async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
    async setPx(key: string, value: string, ttlMs: number): Promise<void> {
        this.values.set(key, value);
        this.ttls.set(key, ttlMs);
    }
    async setPxIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
        if (this.values.has(key)) return false;
        await this.setPx(key, value, ttlMs);
        return true;
    }
    async delete(key: string): Promise<void> {
        this.values.delete(key);
        this.ttls.delete(key);
    }
    async compareAndDelete(key: string, expectedValue: string): Promise<boolean> {
        if (this.values.get(key) !== expectedValue) return false;
        this.values.delete(key);
        this.ttls.delete(key);
        this.compareDeleted.push(key);
        return true;
    }
    async compareAndSetMany(items: readonly AtomicReplacement[]): Promise<boolean> {
        if (items.some(item => (this.values.get(item.key) ?? null) !== item.expected)) return false;
        for (const item of items) { this.values.set(item.key, item.value); this.ttls.set(item.key, item.ttlMs); }
        return true;
    }
    async compareAndSetPx(key: string, expectedValue: string, value: string, ttlMs: number): Promise<boolean> {
        if (this.values.get(key) !== expectedValue) return false;
        await this.setPx(key, value, ttlMs);
        return true;
    }
    readonly expired: string[] = [];
    async expire(key: string, _ttlMs: number): Promise<void> { this.expired.push(key); }
    async compareAndExpire(key: string, expectedValue: string, ttlMs: number): Promise<boolean> {
        if (this.values.get(key) !== expectedValue) return false;
        this.ttls.set(key, ttlMs);
        return true;
    }
    async zAdd(_key: string, _score: number, _member: string): Promise<void> {}
    async zRemove(_key: string, _member: string): Promise<void> {}
    async zRange(_key: string, _start: number, _stop: number): Promise<string[]> { return []; }
    async zRemoveByScore(_key: string, _min: number, _max: number): Promise<number> { return 0; }
    async xGroupCreate(_stream: string, _group: string, _startId: string): Promise<void> {}
    async xReadGroup(
        _stream: string,
        _group: string,
        _consumer: string,
        _blockMs: number,
        _count: number,
    ): Promise<StreamEntry[]> { return []; }
    async xAutoClaim(
        _stream: string,
        _group: string,
        _consumer: string,
        _minIdleMs: number,
        _count: number,
    ): Promise<StreamEntry[]> { return []; }
    async xAdd(_stream: string, _field: string, _value: string, _maxLength: number): Promise<string> { return '1-0'; }
    async xAck(_stream: string, _group: string, _entryId: string): Promise<void> {}
}

const lifecycle: RoomLifecyclePort = {
    startGame: (snapshot) => ({ startTick: 1, taggerId: snapshot.players[0]!.playerId }),
    connectionChanged: () => undefined,
    participantDisconnected: () => undefined,
    participantRemoved: () => undefined,
    stopRoom: () => undefined,
};

function harness() {
    const redis = new FakeRedis();
    const keys = makeKeys('test');
    const rooms = new RoomManager({
        lifecycle,
        isKnownMap: (mapId) => mapId === 'map',
        getServerTick: () => 0,
        violationSink: () => undefined,
        now: () => 1_000,
    });
    const adopted = rooms.adoptRoom({
        serverId: 'game-1',
        roomId: 'room-1',
        roomCode: 'ABC234',
        matchId: 'match-1',
        name: 'room',
        password: null,
        capacity: 8,
        mapId: 'map',
        mode: RoomMode.Match,
        members: [1, 2, 3, 4].map((userId, index) => ({
            userId,
            playerId: userId,
            slot: userId,
            nickname: `p${userId}`,
            guest: false,
            stats: null,
            loadout: SkillId.Dash,
            joinedOrder: index,
            colorIndex: index,
            isHost: userId === 1,
        })),
    });
    assert.equal(adopted.ok, true);
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
            internalAddress: () => 'http://127.0.0.1:4000',
            maxRooms: 100,
            connectionCount: () => 0,
            loopLagMs: () => 0,
            isDraining: () => false,
        },
        now: () => 1_000,
    });
    return { redis, keys, rooms, registry };
}

function activeClaim(roomId: string, userId: ActorId): string {
    return JSON.stringify({
        state: 'assigned',
        requestId: `request-${userId}`,
        roomId,
        serverId: 'game-1',
    });
}

test('해제 큐 뒤 다시 추적된 자리는 active-room을 지키고 강퇴는 끝까지 처리한다', async () => {
    const h = harness();
    for (const userId of [1, 2, 3, 4]) {
        h.redis.values.set(h.keys.userActiveRoom(userId), activeClaim('room-1', userId));
        h.registry.trackSeat('room-1', userId, `request-${userId}`);
    }

    h.registry.noteReleased('room-1', 1, true);
    h.registry.trackSeat('room-1', 1, 'request-1');
    h.registry.noteReleased('room-1', 2, true);

    h.registry.noteKicked('room-1', 3);
    h.registry.noteReleased('room-1', 3, true);
    h.registry.noteKicked('room-1', 4);
    h.registry.noteReleased('room-1', 4, true);
    h.registry.trackSeat('room-1', 4, 'request-4');
    h.rooms.releaseSeat('room-1', 4);

    assert.equal(await h.registry.publish(), true);

    assert.equal(h.redis.values.get(h.keys.userActiveRoom(1)), activeClaim('room-1', 1));
    assert.equal(h.redis.values.get(h.keys.userActiveRoom(2)), activeClaim('room-1', 2));
    assert.equal(h.redis.values.has(h.keys.roomRejoin('room-1', 1)), false);
    assert.equal(h.redis.values.has(h.keys.roomRejoin('room-1', 2)), false);

    assert.equal(h.redis.values.has(h.keys.userActiveRoom(3)), false);
    assert.equal(h.redis.values.has(h.keys.userActiveRoom(4)), false);
    assert.equal(h.redis.values.get(h.keys.roomRejoin('room-1', 3)), '1');
    assert.equal(h.redis.values.get(h.keys.roomRejoin('room-1', 4)), '1');
    assert.equal(h.redis.compareDeleted.includes(h.keys.userActiveRoom(3)), true);
    assert.equal(h.redis.compareDeleted.includes(h.keys.userActiveRoom(4)), true);
});

test('방 인계 중 새 방으로 옮긴 사용자의 claim을 덮지 않고 앞선 변경도 되돌린다', async () => {
    const h = harness();
    const firstOldClaim = JSON.stringify({ state: 'assigned', roomId: 'room-1', serverId: 'game-old' });
    const secondNewClaim = JSON.stringify({ state: 'assigned', roomId: 'room-new', serverId: 'game-new' });
    h.redis.values.set(h.keys.userActiveRoom(1), firstOldClaim);
    h.redis.values.set(h.keys.userActiveRoom(2), secondNewClaim);

    const payload = prepareHandoff(h, [1, 2]);
    await assert.rejects(h.registry.claimAdoptedRoom(payload, h.rooms.get('room-1')!.projection()), /claim changed/);

    assert.equal(h.redis.values.get(h.keys.userActiveRoom(1)), firstOldClaim, '부분 인계는 원래 claim으로 롤백한다');
    assert.equal(h.redis.values.get(h.keys.userActiveRoom(2)), secondNewClaim, '새 방 배정은 보존한다');
});

test('source registry forgets transferred seat cleanup and preserves the adopter same-room claim', async () => {
    const h = harness();
    h.redis.values.set(h.keys.userActiveRoom(1), activeClaim('room-1', 1));
    h.registry.trackSeat('room-1', 1, 'request-1');
    await h.registry.publish();
    const adopted = JSON.stringify({ state: 'assigned', roomId: 'room-1', serverId: 'game-peer', requestId: 'adopt:peer:room-1' });
    h.redis.values.set(h.keys.userActiveRoom(1), adopted);
    h.registry.forgetRoom('room-1');
    h.rooms.get('room-1')!.releaseAfterHandOff(); h.rooms.sweep();
    await h.registry.publish();
    assert.equal(h.redis.values.get(h.keys.userActiveRoom(1)), adopted);
});

test('adopter heartbeat renews the transferred actor claim after admission', async () => {
    const h = harness();
    h.redis.values.set(h.keys.userActiveRoom(1), JSON.stringify({ state: 'assigned', roomId: 'room-1', serverId: 'game-old' }));
    const payload = prepareHandoff(h, [1]);
    await h.registry.claimAdoptedRoom(payload, h.rooms.get('room-1')!.projection());
    h.redis.ttls.set(h.keys.userActiveRoom(1), 1);
    await h.registry.publish();
    assert.equal(h.redis.ttls.get(h.keys.userActiveRoom(1)), 30_000);
});

function prepareHandoff(h: ReturnType<typeof harness>, userIds: number[]) {
    const payload = { ...h.rooms.get('room-1')!.exportForHandOff('game-1'), sourceServerId: 'game-old', transferId: 'transfer-1' };
    payload.members = payload.members.filter(member => userIds.includes(member.userId as number));
    h.redis.values.set(h.keys.room('room-1'), JSON.stringify({ ...h.rooms.get('room-1')!.projection(), serverId: 'game-old' }));
    h.redis.values.set(h.keys.operation('handoff:transfer-1'), 'pending');
    return payload;
}

test('cancelled handoff cannot change any claim or directory', async () => {
    const h = harness();
    const payload = prepareHandoff(h, [1, 2]);
    for (const id of [1, 2]) h.redis.values.set(h.keys.userActiveRoom(id), JSON.stringify({ state: 'assigned', roomId: 'room-1', serverId: 'game-old' }));
    const before = new Map(h.redis.values);
    h.redis.values.set(h.keys.operation('handoff:transfer-1'), 'cancelled');
    await assert.rejects(h.registry.claimAdoptedRoom(payload, h.rooms.get('room-1')!.projection()), /cancelled/);
    for (const [key, value] of before) if (key !== h.keys.operation('handoff:transfer-1')) assert.equal(h.redis.values.get(key), value);
});

test('claim race at commit leaves every other claim and directory unchanged', async () => {
    const h = harness();
    const payload = prepareHandoff(h, [1, 2]);
    for (const id of [1, 2]) h.redis.values.set(h.keys.userActiveRoom(id), JSON.stringify({ state: 'assigned', roomId: 'room-1', serverId: 'game-old' }));
    const before = new Map(h.redis.values);
    const atomic = h.redis.compareAndSetMany.bind(h.redis);
    h.redis.compareAndSetMany = async items => {
        h.redis.values.set(h.keys.userActiveRoom(2), 'new-assignment');
        return atomic(items);
    };
    await assert.rejects(h.registry.claimAdoptedRoom(payload, h.rooms.get('room-1')!.projection()));
    assert.equal(h.redis.values.get(h.keys.userActiveRoom(1)), before.get(h.keys.userActiveRoom(1)));
    assert.equal(h.redis.values.get(h.keys.room('room-1')), before.get(h.keys.room('room-1')));
    assert.equal(h.redis.values.get(h.keys.operation('handoff:transfer-1')), 'pending');
});

test('old owner cannot overwrite or delete the new owner directory', async () => {
    const h = harness();
    await h.registry.publish();
    const newer = JSON.stringify({ serverId: 'game-peer', roomId: 'room-1' });
    h.redis.values.set(h.keys.room('room-1'), newer);
    await h.registry.publish();
    assert.equal(h.redis.values.get(h.keys.room('room-1')), newer);
    h.rooms.get('room-1')!.releaseAfterHandOff(); h.rooms.sweep();
    await h.registry.publish();
    assert.equal(h.redis.values.get(h.keys.room('room-1')), newer);
});

test('staged adoption has no room projection until explicit commit', () => {
    const h = harness();
    const payload = { ...h.rooms.get('room-1')!.exportForHandOff('game-1'), roomId: 'room-staged' };
    const staged = h.rooms.adoptRoom(payload, true);
    assert.equal(staged.ok, true);
    assert.equal(h.rooms.get('room-staged'), null);
    assert.equal(h.rooms.projections().some(room => room.roomId === 'room-staged'), false);
    if (staged.ok) h.rooms.commitAdoptedRoom(staged.value);
    assert.notEqual(h.rooms.get('room-staged'), null);
});


test('source cancels timeout before unfreezing; Redis ambiguity keeps it frozen', async () => {
    const h = harness();
    const room = h.rooms.get('room-1')!;
    Object.assign(room.memberByUser(1)!, { connection: { close: () => undefined } });
    h.redis.zRange = async () => ['game-peer'];
    h.redis.values.set(h.keys.gameServer('game-peer'), JSON.stringify({ serverId: 'game-peer', protocolVersion: PROTOCOL_VERSION, waitingRooms: 0, playingRooms: 0, draining: false }));
    const options = { redis: h.redis, keys: h.keys, rooms: h.rooms, serverId: 'game-1',
        forgetRoom: (id: string) => h.registry.forgetRoom(id), log: () => undefined, confirmTries: 0 };
    assert.equal(await handOffWaitingRooms(options), 0);
    assert.equal(room.handingOff, false);
    assert.ok([...h.redis.values.entries()].some(([key, value]) => key.includes('handoff:') && value === 'cancelled'));
    const cas = h.redis.compareAndSetPx.bind(h.redis);
    h.redis.compareAndSetPx = async () => { throw new Error('offline'); };
    assert.equal(await handOffWaitingRooms(options), 0);
    assert.equal(room.handingOff, true);
    assert.equal(h.rooms.releaseSeat(room.id, 1).ok, false);
    assert.equal(h.rooms.kickUser(room.id, 1, 'kick').ok, false);
    room.advance(1_000_000);
    assert.equal(room.playerCount, 4, 'frozen roster cannot expire');
    h.redis.compareAndSetPx = cas;
    await handOffWaitingRooms(options);
    assert.equal(room.handingOff, false);
});
