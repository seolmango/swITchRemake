import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { ErrorCode, INPUT_PACKET_BYTES, PlayerRole, PROTOCOL_VERSION, RoomState } from 'shared';
import { WebSocket } from 'ws';
import { ConnectionManager } from '../gateway/connection-manager';
import { TicketAuthenticator } from '../gateway/ticket-auth';
import { InMemoryTicketStore } from '../gateway/ticket-store';
import { AbuseRateLimiter } from '../gateway/rate-limit';
import { WsTransport } from './ws-transport';

async function fixture(authTimeoutMs = 200, rateLimiter?: AbuseRateLimiter) {
    // Three tabs can open their handshakes at once behind one NAT before any has authenticated.
    const connections = new ConnectionManager({ maxConnections: 10, maxUnauthenticatedPerIp: 3 });
    const tickets = new InMemoryTicketStore();
    const authenticator = new TicketAuthenticator({
        serverId: 'game-test',
        ticketStore: tickets,
        connections,
        minimumResponseMs: 0,
        rooms: { admitReservation: () => ({ playerId: 2, roomState: RoomState.Waiting, role: PlayerRole.Player }) },
    });
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
        violationSink: () => undefined,
        ...(rateLimiter === undefined ? {} : { rateLimiter }),
        limits: {
            authTimeoutMs,
            maxBinaryFrameBytes: 64,
            maxJsonFrameBytes: 2_048,
            maxInputPacketsPerSec: 90,
            maxJsonCommandsPerSec: 20,
            emojiCooldownMs: 2_000,
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
        onDisconnect: () => undefined,
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
        transport, connected, jsonTypes, jsonReceived, inputUsers, issue,
        waitForInputCount: (target: number) => inputUsers.length >= target
            ? Promise.resolve()
            : new Promise<void>((resolve) => inputWaiters.push({ target, resolve })),
        url: `ws://127.0.0.1:${transport.boundPort()}/game/game-test`,
        bundleUrl: `http://127.0.0.1:${transport.boundPort()}/map-bundles/${'a'.repeat(64)}.json`,
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
