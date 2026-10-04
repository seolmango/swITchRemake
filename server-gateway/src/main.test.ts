import assert from 'node:assert/strict';
import { createServer, get, request, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { test } from 'node:test';
import type { GameServerHeartbeat } from 'shared';
import { IpRateLimiter } from './ip-rate-limit';
import { handleRequest, handleUpgrade } from './main';

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP address');
    return address.port;
}

test('newly issued worker route is looked up before rejecting an upgrade on a cache miss', { timeout: 3_000 }, async () => {
    const upstream = createServer();
    const upgradedSockets = new Set<Socket>();
    upstream.on('upgrade', (_request, socket) => {
        upgradedSockets.add(socket as Socket);
        socket.once('close', () => upgradedSockets.delete(socket as Socket));
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    });
    const upstreamPort = await listen(upstream);
    const servers = new Map<string, GameServerHeartbeat>();
    let lookups = 0;
    const view = { servers, ensureServer: async (serverId: string) => {
        lookups++;
        assert.equal(serverId, 'new-worker');
        const heartbeat = { serverId, internalAddress: `http://127.0.0.1:${upstreamPort}` } as GameServerHeartbeat;
        servers.set(serverId, heartbeat);
        return heartbeat;
    } };
    const proxy = createServer();
    proxy.on('upgrade', (req, socket, head) => { void handleUpgrade(view, req, socket as Socket, head); });
    const proxyPort = await listen(proxy);
    try {
        const status = await new Promise<number>((resolve, reject) => {
            const req = request({ host: '127.0.0.1', port: proxyPort, path: '/game-ws/new-worker',
                headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
            req.on('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode!); });
            req.on('response', response => { response.resume(); resolve(response.statusCode!); });
            req.on('error', reject);
            req.end();
        });
        assert.equal(status, 101);
        assert.equal(lookups, 1);
    } finally {
        for (const socket of upgradedSockets) socket.destroy();
        proxy.closeAllConnections(); upstream.closeAllConnections();
        await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    }
});

test('client TCP reset during the registry lookup stays within the upgrade error boundary', { timeout: 3_000 }, async () => {
    let finishLookup!: (value: null) => void;
    let lookupStarted!: () => void;
    const started = new Promise<void>(resolve => { lookupStarted = resolve; });
    const view = { servers: new Map<string, GameServerHeartbeat>(), ensureServer: async () => {
        lookupStarted(); return new Promise<null>(resolve => { finishLookup = resolve; });
    } };
    const proxy = createServer();
    let handling!: Promise<void>;
    let incoming!: Socket;
    proxy.on('upgrade', (req, socket, head) => {
        incoming = socket as Socket;
        handling = handleUpgrade(view, req, incoming, head);
    });
    const proxyPort = await listen(proxy);
    const client = connect(proxyPort, '127.0.0.1');
    client.on('error', () => undefined);
    try {
        await new Promise<void>(resolve => client.once('connect', resolve));
        client.write('GET /game-ws/new-worker HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
        await started;
        assert.ok(incoming.listenerCount('error') >= 1, 'client errors must be handled before awaiting Redis');
        const closed = new Promise<void>(resolve => incoming.once('close', resolve));
        client.resetAndDestroy();
        await closed;
        finishLookup(null);
        await handling;
        assert.equal(incoming.destroyed, true);
    } finally {
        finishLookup?.(null); client.destroy(); incoming?.destroy();
        await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
});

test('upstream이 응답하지 않아도 공개 요청을 timeout 뒤 502로 끝낸다', async () => {
    const upstream = createServer(() => { /* 응답을 일부러 끝내지 않는다. */ });
    const upstreamPort = await listen(upstream);
    const heartbeat: GameServerHeartbeat = {
        serverId: 'game-1', buildVersion: 'build', protocolVersion: 2, rulesVersion: 'rules',
        mapBundleHash: 'hash', waitingRooms: 0, playingRooms: 0, connections: 0, loopLagMs: 0,
        draining: false, updatedAt: Date.now(), internalAddress: `http://127.0.0.1:${upstreamPort}`, maxRooms: 100,
    };
    const proxy = createServer((request, response) => handleRequest(
        { servers: new Map([[heartbeat.serverId, heartbeat]]) },
        new IpRateLimiter(),
        request,
        response,
        { connectTimeoutMs: 20, responseTimeoutMs: 30, replayRequestsPerMinute: 30 },
    ));
    const proxyPort = await listen(proxy);
    try {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/map-bundles/hash.json`);
        assert.equal(response.status, 502);
    } finally {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
});

test('upstream 본문이 헤더 뒤에 멎으면 해당 다운로드를 끊고 다음 요청을 받는다', { timeout: 2_000 }, async () => {
    const upstream = createServer((_request, response) => {
        response.writeHead(200, { 'content-length': '100' });
        response.write('partial');
    });
    const upstreamPort = await listen(upstream);
    const heartbeat = {
        serverId: 'game-1', internalAddress: `http://127.0.0.1:${upstreamPort}`,
        waitingRooms: 0, playingRooms: 0, connections: 0, draining: false,
    } as GameServerHeartbeat;
    const proxy = createServer((request, response) => handleRequest(
        { servers: new Map([[heartbeat.serverId, heartbeat]]) }, new IpRateLimiter(), request, response,
        { connectTimeoutMs: 20, responseTimeoutMs: 30, replayRequestsPerMinute: 30 },
    ));
    const proxyPort = await listen(proxy);
    try {
        await new Promise<void>((resolve, reject) => {
            const request = get(`http://127.0.0.1:${proxyPort}/map-bundles/hash.json`, (response) => {
                response.resume();
                response.once('aborted', resolve);
                response.once('error', () => undefined);
                response.once('end', () => reject(new Error('truncated download incorrectly completed')));
            });
            request.once('error', reject);
        });
        assert.equal((await fetch(`http://127.0.0.1:${proxyPort}/healthz`)).status, 200);
    } finally {
        proxy.closeAllConnections();
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
});
