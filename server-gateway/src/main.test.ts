import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import type { GameServerHeartbeat } from 'shared';
import { IpRateLimiter } from './ip-rate-limit';
import { handleRequest } from './main';

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP address');
    return address.port;
}

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
