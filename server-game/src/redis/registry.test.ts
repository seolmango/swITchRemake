import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RoomMode, SkillId, makeKeys, type ActorId } from 'shared';
import { RoomManager } from '../rooms/room-manager';
import type { RoomLifecyclePort } from '../rooms/room';
import { GameRegistry } from './registry';
import type { RedisPort, StreamEntry } from './redis-client';

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
    participantTimedOut: () => undefined,
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
