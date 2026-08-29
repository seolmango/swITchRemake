import assert from 'node:assert/strict';
import test from 'node:test';
import { HEARTBEAT_TTL_MS, PROTOCOL_VERSION, makeKeys } from 'shared';
import { AdminService } from './admin.service';

const keys = makeKeys(process.env.APP_ENV ?? 'dev');
// 실제 시계로 잰다. `overview()`가 Date.now()를 보기 때문에 미래 시각을 넣으면 stale 판정이 뒤집힌다.
const NOW = Date.now();

function heartbeat(serverId: string, overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
        serverId,
        buildVersion: 'test',
        protocolVersion: PROTOCOL_VERSION,
        rulesVersion: 'r1',
        mapBundleHash: 'h',
        waitingRooms: 1,
        playingRooms: 2,
        connections: 9,
        loopLagMs: 3,
        draining: false,
        updatedAt: NOW,
        internalAddress: 'http://10.0.0.1:4000',
        maxRooms: 20,
        ...overrides,
    });
}

function redis(values: Record<string, string>, sets: Record<string, string[]>) {
    return {
        get: async (key: string) => values[key] ?? null,
        sortedSetMembers: async (key: string) => sets[key] ?? [],
    };
}

const emptyDb = {
    execute: async () => [{ total: '0', active: '0', banned: '0', deleted: '0', new_last_day: '0', open: '0', last_hour: '0', last_day: '0' }],
};

test('살아 있는 인게임 서버만 방과 접속을 합산한다', async () => {
    const service = new AdminService(emptyDb as never, redis(
        {
            [keys.gameServer('alive')]: heartbeat('alive'),
            [keys.gameServer('dead')]: heartbeat('dead', { updatedAt: NOW - HEARTBEAT_TTL_MS - 1, connections: 100, playingRooms: 50 }),
        },
        { [keys.gameServersAlive()]: ['alive', 'dead'], [keys.roomsWaiting()]: ['room-1', 'room-2'] },
    ) as never);

    const overview = await service.overview();
    assert.equal(overview.gameServers.length, 2);
    assert.equal(overview.gameServers.find((server) => server.serverId === 'dead')!.stale, true);
    // 죽은 서버의 50개 방과 100 접속이 합계에 들어가면 안 된다.
    assert.equal(overview.rooms.playing, 2);
    assert.equal(overview.players.inGame, 9);
    // 대기 방은 heartbeat가 아니라 Redis 목록을 원본으로 센다.
    assert.equal(overview.rooms.waiting, 2);
    assert.equal(overview.rooms.capacity, 20);
    assert.equal(overview.registryDegraded, false);
});

test('serverId가 어긋난 키는 버린다', async () => {
    // 키 이름과 안에 든 값이 다르면 남의 상태이거나 쓰다 만 값이다.
    const service = new AdminService(emptyDb as never, redis(
        { [keys.gameServer('a')]: heartbeat('b') },
        { [keys.gameServersAlive()]: ['a'] },
    ) as never);
    assert.deepEqual((await service.overview()).gameServers, []);
});

test('Redis가 죽어도 DB 숫자는 낸다', async () => {
    // 장애 중에 운영자 화면이 통째로 비면, 정작 화면이 필요한 순간에 아무것도 못 본다.
    const db = {
        execute: async () => [{ total: '7', active: '5', banned: '1', deleted: '1', new_last_day: '2', open: '3', last_hour: '4', last_day: '9' }],
    };
    const service = new AdminService(db as never, {
        get: async () => { throw new Error('redis down'); },
        sortedSetMembers: async () => { throw new Error('redis down'); },
    } as never);

    const overview = await service.overview();
    assert.equal(overview.registryDegraded, true);
    assert.equal(overview.gameServers.length, 0);
    assert.equal(overview.users.total, 7);
    assert.equal(overview.matches.open, 3);
});
