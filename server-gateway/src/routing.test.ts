import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GameServerHeartbeat } from 'shared';
import { resolveBundleBackend, resolveWebSocketBackend } from './routing';

function server(serverId: string, overrides: Partial<GameServerHeartbeat> = {}): GameServerHeartbeat {
    return {
        serverId,
        buildVersion: 'build',
        protocolVersion: 2,
        rulesVersion: 'rules',
        mapBundleHash: 'hash',
        waitingRooms: 0,
        playingRooms: 0,
        connections: 0,
        loopLagMs: 0,
        draining: false,
        internalAddress: `http://127.0.0.1:4000`,
        maxRooms: 100,
        updatedAt: 0,
        ...overrides,
    };
}

const registry = (...list: GameServerHeartbeat[]) =>
    new Map(list.map((entry) => [entry.serverId, entry]));

test('WebSocket은 경로에 박힌 서버로만 간다', () => {
    // 방은 특정 서버에 있고 그 서버만 세계를 들고 있다. 부하가 어떻든 다른 곳으로 보내면
    // 사용자는 빈 방에 들어간다.
    const servers = registry(
        server('game-1', { internalAddress: 'http://10.0.0.1:4000', playingRooms: 9 }),
        server('game-2', { internalAddress: 'http://10.0.0.2:4000' }),
    );
    assert.deepEqual(resolveWebSocketBackend('/game-ws/game-1', servers), {
        serverId: 'game-1',
        address: 'http://10.0.0.1:4000',
    });
});

test('경로가 더 이어져도 첫 조각만 본다', () => {
    const servers = registry(server('game-1', { internalAddress: 'http://10.0.0.1:4000' }));
    for (const path of ['/game-ws/game-1/', '/game-ws/game-1?x=1', '/game-ws/game-1#f']) {
        assert.equal(resolveWebSocketBackend(path, servers)?.serverId, 'game-1', path);
    }
});

test('draining 중인 서버로도 WebSocket을 보낸다', () => {
    // 남은 경기의 재접속이 이 경로로 온다. 여기서 막으면 마지막 사람들이 돌아올 길이 없다.
    const servers = registry(server('game-1', { draining: true, internalAddress: 'http://10.0.0.1:4000' }));
    assert.notEqual(resolveWebSocketBackend('/game-ws/game-1', servers), null);
});

test('모르는 서버나 주소 없는 서버는 거절한다', () => {
    const servers = registry(server('game-1', { internalAddress: '' }));
    assert.equal(resolveWebSocketBackend('/game-ws/game-1', servers), null, '주소를 모르면 보낼 수 없다');
    assert.equal(resolveWebSocketBackend('/game-ws/ghost', servers), null);
    assert.equal(resolveWebSocketBackend('/game-ws/', servers), null);
    assert.equal(resolveWebSocketBackend('/other', servers), null);
});

test('맵 번들은 한가한 서버로 보낸다', () => {
    // 번들은 해시로 주소가 정해지는 불변 데이터라 어느 서버가 줘도 같다.
    const servers = registry(
        server('game-1', { playingRooms: 5, internalAddress: 'http://10.0.0.1:4000' }),
        server('game-2', { playingRooms: 0, internalAddress: 'http://10.0.0.2:4000' }),
    );
    assert.equal(resolveBundleBackend('/map-bundles/abc.json', servers)?.serverId, 'game-2');
});

test('맵 번들은 draining 서버를 피한다', () => {
    const servers = registry(
        server('game-1', { draining: true, internalAddress: 'http://10.0.0.1:4000' }),
        server('game-2', { playingRooms: 7, internalAddress: 'http://10.0.0.2:4000' }),
    );
    assert.equal(resolveBundleBackend('/map-bundles/abc.json', servers)?.serverId, 'game-2');
});

test('같은 상태면 늘 같은 서버로 보낸다', () => {
    // 동률을 무작위로 깨면 같은 번들이 서버마다 따로 캐시된다.
    const servers = registry(
        server('game-2', { internalAddress: 'http://10.0.0.2:4000' }),
        server('game-1', { internalAddress: 'http://10.0.0.1:4000' }),
    );
    for (let i = 0; i < 5; i += 1) {
        assert.equal(resolveBundleBackend('/map-bundles/abc.json', servers)?.serverId, 'game-1');
    }
});

test('서버가 하나도 없으면 번들도 못 준다', () => {
    assert.equal(resolveBundleBackend('/map-bundles/abc.json', registry()), null);
});
