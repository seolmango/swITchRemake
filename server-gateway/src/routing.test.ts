import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GameServerHeartbeat } from 'shared';
import {
    filterHttpRequestHeaders,
    filterWebSocketRequestHeaders,
    resolveBundleRoute,
    resolveWebSocketRoute,
    type Backend,
    type RouteResolution,
} from './routing';

const backendOf = (resolution: RouteResolution): Backend | null =>
    resolution.kind === 'route' ? resolution.route.backend : null;
const bundleBackend = (path: string, servers: ReadonlyMap<string, GameServerHeartbeat>): Backend | null =>
    backendOf(resolveBundleRoute(path, servers));
const webSocketBackend = (path: string, servers: ReadonlyMap<string, GameServerHeartbeat>): Backend | null =>
    backendOf(resolveWebSocketRoute(path, servers));

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
    assert.deepEqual(webSocketBackend('/game-ws/game-1', servers), {
        serverId: 'game-1',
        address: 'http://10.0.0.1:4000',
    });
});

test('경로가 더 이어져도 첫 조각만 본다', () => {
    const servers = registry(server('game-1', { internalAddress: 'http://10.0.0.1:4000' }));
    for (const path of ['/game-ws/game-1/', '/game-ws/game-1?x=1', '/game-ws/game-1#f']) {
        assert.equal(webSocketBackend(path, servers)?.serverId, 'game-1', path);
    }
});

test('draining 중인 서버로도 WebSocket을 보낸다', () => {
    // 남은 경기의 재접속이 이 경로로 온다. 여기서 막으면 마지막 사람들이 돌아올 길이 없다.
    const servers = registry(server('game-1', { draining: true, internalAddress: 'http://10.0.0.1:4000' }));
    assert.notEqual(webSocketBackend('/game-ws/game-1', servers), null);
});

test('모르는 서버나 주소 없는 서버는 거절한다', () => {
    const servers = registry(server('game-1', { internalAddress: '' }));
    assert.equal(webSocketBackend('/game-ws/game-1', servers), null, '주소를 모르면 보낼 수 없다');
    assert.equal(webSocketBackend('/game-ws/ghost', servers), null);
    assert.equal(webSocketBackend('/game-ws/', servers), null);
    assert.equal(webSocketBackend('/other', servers), null);
});

test('맵 번들은 한가한 서버로 보낸다', () => {
    // 번들은 해시로 주소가 정해지는 불변 데이터라 어느 서버가 줘도 같다.
    const servers = registry(
        server('game-1', { playingRooms: 5, internalAddress: 'http://10.0.0.1:4000' }),
        server('game-2', { playingRooms: 0, internalAddress: 'http://10.0.0.2:4000' }),
    );
    assert.equal(bundleBackend('/map-bundles/abc.json', servers)?.serverId, 'game-2');
});

test('맵 번들은 draining 서버를 피한다', () => {
    const servers = registry(
        server('game-1', { draining: true, internalAddress: 'http://10.0.0.1:4000' }),
        server('game-2', { playingRooms: 7, internalAddress: 'http://10.0.0.2:4000' }),
    );
    assert.equal(bundleBackend('/map-bundles/abc.json', servers)?.serverId, 'game-2');
});

test('같은 상태면 늘 같은 서버로 보낸다', () => {
    // 동률을 무작위로 깨면 같은 번들이 서버마다 따로 캐시된다.
    const servers = registry(
        server('game-2', { internalAddress: 'http://10.0.0.2:4000' }),
        server('game-1', { internalAddress: 'http://10.0.0.1:4000' }),
    );
    for (let i = 0; i < 5; i += 1) {
        assert.equal(bundleBackend('/map-bundles/abc.json', servers)?.serverId, 'game-1');
    }
});

test('서버가 하나도 없으면 번들도 못 준다', () => {
    assert.equal(bundleBackend('/map-bundles/abc.json', registry()), null);
});

test('리플레이 파일도 한가한 서버로 넘긴다', () => {
    // 로컬 저장소에서는 같은 기계의 서버들이 한 디렉터리를 본다. 표를 확인하는 것은 어느 쪽이든 같다.
    const servers = new Map([
        ['game-1', server('game-1', { waitingRooms: 5 })],
        ['game-2', server('game-2', { waitingRooms: 0 })],
    ]);
    assert.equal(bundleBackend('/replays/match-1.swrp?ticket=abc', servers)?.serverId, 'game-2');
});

test('정규화 뒤 허용 접두사 밖으로 나간 경로는 거절한다', () => {
    const servers = registry(server('game-1'));
    assert.equal(bundleBackend('/replays/%2e%2e/internal', servers), null);
    assert.equal(bundleBackend('/map-bundles/%2E%2E/internal', servers), null);
    assert.equal(webSocketBackend('/game-ws/%2e%2e/internal', servers), null);

    const resolution = resolveBundleRoute('/replays/season/%2e/match.swrp?ticket=abc', servers);
    assert.equal(resolution.kind, 'route');
    if (resolution.kind === 'route') {
        assert.equal(resolution.route.path, '/replays/season/match.swrp?ticket=abc');
    }
});

test('자격증명은 버리고 관측한 소켓 주소를 전달 사슬 끝에 잇는다', () => {
    const headers = {
        accept: 'application/json',
        authorization: 'Bearer secret',
        cookie: 'session=secret',
        forwarded: 'for=198.51.100.1',
        host: 'gateway.example',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'key',
        'x-forwarded-for': '198.51.100.2',
        'x-real-ip': '198.51.100.3',
    };

    // 사슬을 남기는 이유는 게이트웨이 앞에 프록시가 하나 더 있을 수 있어서다. 읽는 쪽이
    // 오른쪽부터 신뢰하는 홉을 걷어내므로 클라이언트가 앞에 무엇을 적든 위조가 되지 않는다.
    assert.deepEqual(filterHttpRequestHeaders(headers, '[2001:db8::1]'), {
        accept: 'application/json',
        'x-forwarded-for': '198.51.100.2, 2001:db8::1',
    });
    assert.deepEqual(filterWebSocketRequestHeaders(headers, '203.0.113.4'), {
        host: 'gateway.example',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'key',
        'x-forwarded-for': '198.51.100.2, 203.0.113.4',
    });

    // 앞이 비어 있으면 우리가 본 주소 하나만 남는다.
    assert.deepEqual(filterHttpRequestHeaders({ accept: 'x' }, '203.0.113.9'), {
        accept: 'x',
        'x-forwarded-for': '203.0.113.9',
    });
});
