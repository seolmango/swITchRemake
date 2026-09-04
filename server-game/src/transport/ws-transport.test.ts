import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { ErrorCode, INPUT_PACKET_BYTES, PlayerRole, PROTOCOL_VERSION, RoomState, type ViolationSignal } from 'shared';
import { WebSocket } from 'ws';
import { ConnectionManager } from '../gateway/connection-manager';
import { TicketAuthenticator } from '../gateway/ticket-auth';
import { InMemoryTicketStore } from '../gateway/ticket-store';
import { AbuseRateLimiter } from '../gateway/rate-limit';
import { resolveClientIp, WsTransport } from './ws-transport';

function requestFrom(peer: string, forwarded?: string): Parameters<typeof resolveClientIp>[0] {
    return {
        socket: { remoteAddress: peer },
        headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
    } as Parameters<typeof resolveClientIp>[0];
}

describe('client ip', () => {
    const trusted = ['10.0.0.0/8'];

    it('낯선 소켓이 직접 붙으면 헤더를 보지 않는다', () => {
        assert.equal(resolveClientIp(requestFrom('203.0.113.7', '198.51.100.1'), trusted), '203.0.113.7');
    });

    it('신뢰하는 홉 뒤에서는 사슬의 오른쪽부터 홉을 걷어낸다', () => {
        // 왼쪽 끝은 클라이언트가 직접 적은 값이다. 프록시는 뒤에 이어 붙일 뿐 지우지 않는다.
        const request = requestFrom('10.0.0.9', '1.2.3.4, 203.0.113.7, 10.0.0.8');
        assert.equal(resolveClientIp(request, trusted), '203.0.113.7');
    });

    it('사슬이 전부 우리 홉이면 직접 본 주소를 쓴다', () => {
        assert.equal(resolveClientIp(requestFrom('10.0.0.9', '10.0.0.8'), trusted), '10.0.0.9');
    });

    it('IPv4-mapped와 대괄호 표기를 같은 주소로 본다', () => {
        assert.equal(resolveClientIp(requestFrom('10.0.0.9', '::ffff:203.0.113.7'), trusted), '203.0.113.7');
    });
});

interface FixtureOptions {
    throwAuthenticationOnce?: boolean;
    throwDisconnect?: boolean;
    readReplay?: (storageKey: string, ticket: string) => Promise<Uint8Array | null>;
    maxReplayRequestsPerMinute?: number;
    maxConcurrentReplayDownloads?: number;
    maxIpInputPacketsPerSec?: number;
}

async function fixture(authTimeoutMs = 200, rateLimiter?: AbuseRateLimiter, fixtureOptions: FixtureOptions = {}) {
    // Three tabs can open their handshakes at once behind one NAT before any has authenticated.
    const connections = new ConnectionManager({ maxConnections: 10, maxUnauthenticatedPerIp: 3, maxAuthenticatedPerIp: 6 });
    const tickets = new InMemoryTicketStore();
    const baseAuthenticator = new TicketAuthenticator({
        serverId: 'game-test',
        ticketStore: tickets,
        connections,
        minimumResponseMs: 0,
        rooms: { admitReservation: () => ({ playerId: 2, roomState: RoomState.Waiting, role: PlayerRole.Player }) },
    });
    let throwAuthentication = fixtureOptions.throwAuthenticationOnce ?? false;
    const authenticator = fixtureOptions.throwAuthenticationOnce
        ? ({
            authenticate: async (connectionId: number, ticket: string) => {
                if (throwAuthentication) {
                    throwAuthentication = false;
                    throw new Error('authentication exploded');
                }
                return baseAuthenticator.authenticate(connectionId, ticket);
            },
        } as unknown as TicketAuthenticator)
        : baseAuthenticator;
    const violations: ViolationSignal[] = [];
    const transport = new WsTransport({
        host: '127.0.0.1',
        port: 0,
        path: '/game/game-test',
        allowedOrigins: ['https://switch.example.com'],
        trustedProxies: [],
        connections,
        authenticator,
        metadata: { protocolVersion: PROTOCOL_VERSION, rulesVersion: 'test', mapBundleHash: 'a'.repeat(64) },
        mapBundleBody: '{"ok":true}',
        getServerTick: () => 11,
        violationSink: (signal) => violations.push(signal),
        ...(fixtureOptions.readReplay === undefined ? {} : { readReplay: fixtureOptions.readReplay }),
        ...(rateLimiter === undefined ? {} : { rateLimiter }),
        limits: {
            authTimeoutMs,
            maxBinaryFrameBytes: 64,
            maxJsonFrameBytes: 2_048,
            maxInputPacketsPerSec: 90,
            maxJsonCommandsPerSec: 20,
            maxIpInputPacketsPerSec: fixtureOptions.maxIpInputPacketsPerSec ?? 900,
            maxIpJsonCommandsPerSec: 200,
            emojiCooldownMs: 2_000,
            maxReplayRequestsPerMinute: fixtureOptions.maxReplayRequestsPerMinute ?? 30,
            maxConcurrentReplayDownloads: fixtureOptions.maxConcurrentReplayDownloads ?? 4,
            socketBufferSoftLimitBytes: 64 * 1024,
            socketBufferHardLimitBytes: 512 * 1024,
            socketBufferHardLimitGraceMs: 100,
        },
    });
    const connected: number[] = [];
    const jsonTypes: string[] = [];
    const inputUsers: Array<number | string> = [];
    const inputWaiters: Array<{ target: number; resolve: () => void }> = [];
    let resolveJson!: (type: string) => void;
    const jsonReceived = new Promise<string>((resolve) => { resolveJson = resolve; });
    await transport.listen({
        onConnect: (connection) => connected.push(connection.playerId),
        onInput: (connection) => {
            inputUsers.push(connection.userId);
            for (const waiter of inputWaiters.splice(0)) {
                if (inputUsers.length >= waiter.target) waiter.resolve();
                else inputWaiters.push(waiter);
            }
        },
        onJson: (_connection, message) => { jsonTypes.push(message.type); resolveJson(message.type); },
        onDisconnect: () => {
            if (fixtureOptions.throwDisconnect) throw new Error('disconnect exploded');
        },
    });
    const issue = (userId = 9) => tickets.issue({
        userId,
        nickname: `user-${userId}`,
        lobbyStats: null,
        roomId: 'room-1',
        serverId: 'game-test',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 15_000,
        resume: true,
    });
    return {
        transport, connected, jsonTypes, jsonReceived, inputUsers, issue, violations,
        waitForInputCount: (target: number) => inputUsers.length >= target
            ? Promise.resolve()
            : new Promise<void>((resolve) => inputWaiters.push({ target, resolve })),
        url: `ws://127.0.0.1:${transport.boundPort()}/game/game-test`,
        bundleUrl: `http://127.0.0.1:${transport.boundPort()}/map-bundles/${'a'.repeat(64)}.json`,
        replayUrl: `http://127.0.0.1:${transport.boundPort()}/replays/match-1.swrp`,
    };
}

function connect(url: string, origin = 'https://switch.example.com'): WebSocket {
    return new WebSocket(url, { origin });
}

async function authenticate(url: string, ticket: string): Promise<WebSocket> {
    const socket = connect(url);
    await once(socket, 'open');
    socket.send(JSON.stringify({ v: 1, type: 'auth', payload: { ticket } }));
    await once(socket, 'message');
    return socket;
}

async function closeSockets(sockets: readonly WebSocket[]): Promise<void> {
    await Promise.all(sockets.map(async (socket) => {
        if (socket.readyState === WebSocket.CLOSED) return;
        const closed = once(socket, 'close');
        if (socket.readyState === WebSocket.OPEN) socket.close();
        else socket.terminate();
        await closed;
    }));
}

describe('ws transport', () => {
    it('serves the immutable map bundle only at its advertised hash', async () => {
        const f = await fixture();
        try {
            const response = await fetch(f.bundleUrl, { headers: { Origin: 'https://switch.example.com' } });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
            assert.equal(response.headers.get('access-control-allow-origin'), 'https://switch.example.com');
            assert.deepEqual(await response.json(), { ok: true });
        } finally {
            await f.transport.close();
        }
    });

    it('rejects an unapproved Origin during upgrade', async () => {
        const f = await fixture();
        const socket = connect(f.url, 'https://evil.example');
        socket.on('error', () => undefined);
        const [request, response] = await once(socket, 'unexpected-response');
        assert.equal((response as { statusCode: number }).statusCode, 403);
        (request as { destroy(): void }).destroy();
        await f.transport.close();
    });

    it('accepts only a first-message ticket, emits auth.ok, and routes validated JSON', async () => {
        const f = await fixture();
        const grant = f.issue();
        const socket = connect(f.url);
        try {
            await once(socket, 'open');
            socket.send(JSON.stringify({ v: 1, type: 'auth', payload: { ticket: grant.ticket } }));
            const [authData] = await once(socket, 'message');
            const auth = JSON.parse(String(authData)) as { type: string; payload: { playerId: number; roomId: string } };
            assert.deepEqual([auth.type, auth.payload.playerId, auth.payload.roomId], ['auth.ok', 2, 'room-1']);
            assert.deepEqual(f.connected, [2]);
            socket.send(JSON.stringify({ v: 1, type: 'ping', requestId: 8, payload: { clientTime: 3 } }));
            assert.equal(await f.jsonReceived, 'ping');
            assert.deepEqual(f.jsonTypes, ['ping']);
        } finally {
            if (socket.readyState === WebSocket.OPEN) {
                socket.close();
                await once(socket, 'close');
            }
            await f.transport.close();
        }
    });

    it('closes unauthenticated sockets at the authentication deadline', async () => {
        const f = await fixture(30);
        const socket = connect(f.url);
        await once(socket, 'open');
        const messages: string[] = [];
        socket.on('message', (data) => messages.push(String(data)));
        const [code] = await once(socket, 'close');
        assert.equal(code, 1008);
        assert.match(messages[0] ?? '', /AUTH_TIMEOUT/u);
        await f.transport.close();
    });

    it('does not accept a ticket in the URL', async () => {
        const f = await fixture();
        const socket = connect(`${f.url}?ticket=${f.issue().ticket}`);
        socket.on('error', () => undefined);
        const [request, response] = await once(socket, 'unexpected-response');
        assert.equal((response as { statusCode: number }).statusCode, 400);
        (request as { destroy(): void }).destroy();
        await f.transport.close();
    });

    it('인증 Promise가 throw해도 그 연결만 INTERNAL로 닫고 다음 연결은 받는다', async () => {
        const f = await fixture(200, undefined, { throwAuthenticationOnce: true });
        const failed = connect(f.url);
        try {
            await once(failed, 'open');
            const failedMessages: string[] = [];
            failed.on('message', (data) => failedMessages.push(String(data)));
            failed.send(JSON.stringify({ v: 1, type: 'auth', payload: { ticket: f.issue(1).ticket } }));
            const [code] = await once(failed, 'close');
            assert.equal(code, 1008);
            assert.match(failedMessages[0] ?? '', /INTERNAL/u);
            assert.equal(f.violations.some((signal) => signal.detail?.['phase'] === 'message'), true);

            const healthy = await authenticate(f.url, f.issue(2).ticket);
            await closeSockets([healthy]);
        } finally {
            await closeSockets([failed]);
            await f.transport.close();
        }
    });

    it('onDisconnect가 throw해도 close 이벤트 경계를 벗어나지 않는다', async () => {
        const f = await fixture(200, undefined, { throwDisconnect: true });
        let second: WebSocket | null = null;
        try {
            const first = await authenticate(f.url, f.issue(1).ticket);
            const firstClosed = once(first, 'close');
            first.close();
            await firstClosed;
            for (let attempt = 0; attempt < 20 && !f.violations.some((signal) => signal.detail?.['phase'] === 'disconnect'); attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            assert.equal(f.violations.some((signal) => signal.detail?.['phase'] === 'disconnect'), true);

            second = await authenticate(f.url, f.issue(2).ticket);
        } finally {
            if (second !== null) await closeSockets([second]);
            await f.transport.close();
        }
    });

    it('형식이 틀린 리플레이 표는 저장소 조회 전에 404로 버린다', async () => {
        let reads = 0;
        const f = await fixture(200, undefined, {
            readReplay: async () => { reads += 1; return new Uint8Array([1]); },
        });
        try {
            const response = await fetch(`${f.replayUrl}?ticket=not-a-ticket`);
            assert.equal(response.status, 404);
            assert.equal(reads, 0);
        } finally {
            await f.transport.close();
        }
    });

    it('리플레이 조회를 IP별로 제한하고 동시 readFile 수에도 상한을 둔다', async () => {
        let releaseFirst!: () => void;
        const firstRead = new Promise<void>((resolve) => { releaseFirst = resolve; });
        let reads = 0;
        const f = await fixture(200, undefined, {
            maxReplayRequestsPerMinute: 2,
            maxConcurrentReplayDownloads: 1,
            readReplay: async () => {
                reads += 1;
                if (reads === 1) await firstRead;
                return null;
            },
        });
        const ticket = 'a'.repeat(32);
        try {
            const pending = fetch(`${f.replayUrl}?ticket=${ticket}`);
            while (reads === 0) await new Promise((resolve) => setImmediate(resolve));
            const busy = await fetch(`${f.replayUrl}?ticket=${ticket}`);
            assert.equal(busy.status, 503);
            const limited = await fetch(`${f.replayUrl}?ticket=${ticket}`);
            assert.equal(limited.status, 429);
            assert.equal(reads, 1);
            releaseFirst();
            assert.equal((await pending).status, 404);
        } finally {
            releaseFirst();
            await f.transport.close();
        }
    });

    it('rate-limits consecutive emoji commands from the same player', async () => {
        const f = await fixture();
        const socket = connect(f.url);
        try {
            await once(socket, 'open');
            socket.send(JSON.stringify({ v: 1, type: 'auth', payload: { ticket: f.issue().ticket } }));
            await once(socket, 'message');

            socket.send(JSON.stringify({ v: 1, type: 'game.emoji', requestId: 1, payload: { emojiId: 3 } }));
            assert.equal(await f.jsonReceived, 'game.emoji');

            const rejected = once(socket, 'message');
            socket.send(JSON.stringify({ v: 1, type: 'game.emoji', requestId: 2, payload: { emojiId: 4 } }));
            const [data] = await rejected;
            const message = JSON.parse(String(data)) as { type: string; payload: { code: string } };
            assert.equal(message.type, 'error');
            assert.equal(message.payload.code, ErrorCode.RateLimited);
            assert.deepEqual(f.jsonTypes, ['game.emoji']);
        } finally {
            if (socket.readyState === WebSocket.OPEN) {
                socket.close();
                await once(socket, 'close');
            }
            await f.transport.close();
        }
    });

    it('accepts 30 input packets from each of three connections sharing an IP', async () => {
        const f = await fixture();
        const sockets = [connect(f.url), connect(f.url), connect(f.url)];
        try {
            await Promise.all(sockets.map(async (socket, index) => {
                await once(socket, 'open');
                socket.send(JSON.stringify({ v: 1, type: 'auth', payload: { ticket: f.issue(index + 1).ticket } }));
                await once(socket, 'message');
            }));
            for (let packet = 0; packet < 30; packet += 1) {
                for (const socket of sockets) socket.send(Buffer.alloc(INPUT_PACKET_BYTES));
            }
            await f.waitForInputCount(90);
            assert.deepEqual(f.inputUsers.reduce<Record<string, number>>((counts, userId) => {
                counts[String(userId)] = (counts[String(userId)] ?? 0) + 1;
                return counts;
            }, {}), { 1: 30, 2: 30, 3: 30 });
            assert.ok(sockets.every((socket) => socket.readyState === WebSocket.OPEN));
        } finally {
            await closeSockets(sockets);
            await f.transport.close();
        }
    });

    it('연결별 여유가 남아도 같은 IP의 합산 입력 예산을 넘으면 버린다', async () => {
        const f = await fixture(200, undefined, { maxIpInputPacketsPerSec: 4 });
        const sockets = [await authenticate(f.url, f.issue(1).ticket), await authenticate(f.url, f.issue(2).ticket)];
        try {
            for (const socket of sockets) {
                for (let packet = 0; packet < 3; packet += 1) socket.send(Buffer.alloc(INPUT_PACKET_BYTES));
            }
            await f.waitForInputCount(4);
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(f.inputUsers.length, 4);
            assert.ok(sockets.every((socket) => socket.readyState === WebSocket.OPEN));
        } finally {
            await closeSockets(sockets);
            await f.transport.close();
        }
    });

    it('drops ordinary persistent input excess without closing the socket', async () => {
        let now = 0;
        const f = await fixture(200, new AbuseRateLimiter(() => now));
        const socket = await authenticate(f.url, f.issue(1).ticket);
        try {
            for (let window = 0; window < 3; window += 1) {
                for (let packet = 0; packet < 91; packet += 1) socket.send(Buffer.alloc(INPUT_PACKET_BYTES));
                await f.waitForInputCount((window + 1) * 90);
                now += 1_000;
            }
            assert.equal(f.inputUsers.length, 270);
            assert.equal(socket.readyState, WebSocket.OPEN);
        } finally {
            await closeSockets([socket]);
            await f.transport.close();
        }
    });
});
