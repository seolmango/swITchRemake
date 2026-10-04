import { test, expect } from '@playwright/test';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { apiLogin, database, isolatedContext, seedAccount } from './helpers';

// Only the disposable internal stack is a valid destination. No arbitrary URL or
// environment endpoint is accepted by these bounded probes.
function auditSocket(path: string, origin: string): WebSocket {
    if (process.env.AUDIT_STACK !== 'true' || process.env.E2E_BASE_URL !== 'http://web'
        || !/^\/game-ws\/[A-Za-z0-9_-]{1,128}$/.test(path)) throw new Error('Non-audit socket refused');
    return new WebSocket(`ws://web${path}`, { origin, handshakeTimeout: 3_000, maxPayload: 256_000 });
}
function receive(socket: WebSocket, expectedType: string, action: () => void, timeoutMs = 5_000) {
    return new Promise<Record<string, any>>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); socket.off('message', onMessage); socket.off('close', onClose); };
        const onClose = () => { finish(); reject(new Error(`Socket closed awaiting ${expectedType}`)); };
        const onMessage = (buffer: WebSocket.RawData, binary: boolean) => {
            if (binary) return;
            let event; try { event = JSON.parse(buffer.toString()); } catch { return; }
            if (event.type === expectedType) { finish(); resolve(event); }
        };
        const timer = setTimeout(() => { finish(); reject(new Error(`Timed out awaiting ${expectedType}`)); }, timeoutMs);
        socket.on('message', onMessage); socket.on('close', onClose);
        action();
    });
}
async function open(socket: WebSocket) {
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', () => reject(new Error('Audit handshake failed'))); });
}

test('allowed origins and sessions work; unrelated identities and bounded malformed protocol are denied', async ({ browser }, testInfo) => {
    test.setTimeout(180_000);
    const first = await isolatedContext(browser);
    const second = await isolatedContext(browser);
    const sockets: WebSocket[] = [];
    const db = database();
    try {
        const accountA = await seedAccount(); const accountB = await seedAccount();
        const headersA = await apiLogin(first.context, accountA);
        const headersB = await apiLogin(second.context, accountB);
        expect((await first.context.request.get('/api/users/me/stats', { headers: headersA })).status()).toBe(200);
        expect((await second.context.request.get('/api/users/me/stats', { headers: headersB })).status()).toBe(200);
        expect((await second.context.request.get('/api/admin/overview', { headers: headersB })).status()).toBe(403);
        expect((await first.context.request.get('/api/rooms')).status()).toBe(401);

        const sessionsA = await (await first.context.request.get('/api/users/me/sessions', { headers: headersA })).json();
        expect(Object.keys(sessionsA).sort()).toEqual(['sessions']);
        expect(sessionsA.sessions.every((item: object) => Object.keys(item).sort().join(',')
            === ['createdAt', 'current', 'deviceLabel', 'expiresAt', 'id', 'lastUsedAt'].sort().join(','))).toBe(true);
        const sessionA = sessionsA.sessions.find((item: { current: boolean }) => item.current).id;
        expect((await second.context.request.delete(`/api/users/me/sessions/${sessionA}`, { headers: headersB })).status()).toBe(404);
        expect((await first.context.request.get('/api/users/me/stats', { headers: headersA })).status()).toBe(200);

        const created = await first.context.request.post('/api/rooms', { headers: headersA, data: { name: '경계검증', capacity: 3, mapId: 'TestMap1' } });
        expect(created.status()).toBe(201);
        const grant = await created.json();
        if (typeof grant.ticket !== 'string') throw new Error('No synthetic room ticket');
        expect(Object.keys(grant).sort()).toEqual(['expiresAt', 'mapId', 'roomCode', 'roomId', 'ticket', 'wsPath'].sort());
        expect(grant.mapId).toBe('TestMap1');
        expect(grant.expiresAt > Date.now()).toBe(true);
        expect((await second.context.request.post(`/api/rooms/${grant.roomId}/resume`, { headers: headersB })).status()).toBe(409);

        // Rejected Origin never reaches first-message ticket authentication.
        const rejected = auditSocket(grant.wsPath, 'http://untrusted.invalid'); sockets.push(rejected);
        const rejectedStatus = await new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => { rejected.terminate(); reject(new Error('Origin rejection timed out')); }, 5_000);
            rejected.on('unexpected-response', (_request, response) => { clearTimeout(timer); response.resume(); rejected.terminate(); resolve(response.statusCode ?? 0); });
            rejected.once('open', () => { clearTimeout(timer); reject(new Error('Disallowed origin accepted')); });
            rejected.once('error', () => undefined);
        });
        expect(rejectedStatus).toBe(403);
        const accepted = auditSocket(grant.wsPath, 'http://web'); sockets.push(accepted); await open(accepted);
        const auth = await receive(accepted, 'auth.ok', () => accepted.send(JSON.stringify({ v: 1, type: 'auth', payload: { ticket: grant.ticket } })));
        expect(auth.payload.roomId).toBe(grant.roomId);
        const bundleUrl = `/map-bundles/${auth.payload.mapBundleHash}.json`;
        expect((await first.context.request.get(bundleUrl)).status()).toBe(200);
        expect((await first.context.request.post(bundleUrl)).status()).toBe(405);

        const corpus = [
            '{', '[]', JSON.stringify({ v: 999, type: 'ping', payload: { clientTime: 1 } }),
            JSON.stringify({ v: 1, type: 'unknown', payload: {} }),
            JSON.stringify({ v: 1, type: 'lobby.start', userId: accountB.id, payload: {} }),
            JSON.stringify({ v: 1, type: 'game.useSkill', payload: { slot: 1.5 } }),
            JSON.stringify({ v: 1, type: 'lobby.setLocked', payload: { locked: 'true' } }),
        ];
        for (const frame of corpus) {
            const error = await receive(accepted, 'error', () => accepted.send(frame));
            expect(error.payload.code).toBe('INVALID_PAYLOAD');
        }
        for (const length of [0, 1, 5, 7, 32]) accepted.send(Buffer.alloc(length));
        const pong = await receive(accepted, 'pong', () => accepted.send(JSON.stringify({ v: 1, type: 'ping', payload: { clientTime: 123 } })));
        expect(pong.payload.clientTime).toBe(123);
        const duplicate = auditSocket(grant.wsPath, 'http://web'); sockets.push(duplicate); await open(duplicate);
        const reused = await receive(duplicate, 'error', () => duplicate.send(JSON.stringify({ v: 1, type: 'auth', payload: { ticket: grant.ticket } })));
        expect(reused.payload.code).toBe('AUTH_FAILED');
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { accepted.terminate(); reject(new Error('Synthetic leave did not close socket')); }, 3_000);
            accepted.once('close', () => { clearTimeout(timer); resolve(); });
            accepted.send(JSON.stringify({ v: 1, type: 'lobby.leave', requestId: 500, payload: {} }));
        });

        // A fixed copied cookie makes both operations use the same refresh generation.
        const cookie = (await second.context.cookies()).find(value => value.name === 'refreshToken');
        if (!cookie) throw new Error('Synthetic refresh cookie missing');
        const race = await Promise.all([0, 1].map(() => second.context.request.post('/api/auth/refresh', {
            headers: { Cookie: `refreshToken=${cookie.value}` }, timeout: 10_000,
        })));
        expect(race.map(response => response.status()).sort()).toEqual([201, 201]);
        const rotations = await Promise.all(race.map(response => response.json()));
        if (rotations.some(value => typeof value.accessToken !== 'string')) throw new Error('Refresh winner omitted access token');
        if (rotations[0].accessToken !== rotations[1].accessToken) throw new Error('Grace refresh requests issued different successors');
        const winner = rotations[0];
        expect((await second.context.request.get('/api/users/me/stats', {
            headers: { Authorization: `Bearer ${winner.accessToken}` },
        })).status()).toBe(200);
        // The deployed ten-second grace preserves legitimate concurrent tabs;
        // replay after that bound must still revoke the credential family.
        await new Promise(resolve => setTimeout(resolve, 11_000));
        expect((await second.context.request.post('/api/auth/refresh', {
            headers: { Cookie: `refreshToken=${cookie.value}` }, timeout: 10_000,
        })).status()).toBe(401);
        const [liveAfterReuse] = await db`select count(*)::int as count from sessions where user_id=${accountB.id} and revoked_at is null`;
        expect(liveAfterReuse!.count).toBe(0);
        expect((await second.context.request.get('/api/users/me/stats', {
            headers: { Authorization: `Bearer ${winner.accessToken}` },
        })).status()).toBe(401);
        expect((await second.context.request.get('/api/users/me/stats', { headers: headersB })).status()).toBe(401);
        expect((await first.context.request.post('/api/auth/logout', { headers: headersA })).status()).toBe(201);
        expect((await first.context.request.get('/api/users/me/stats', { headers: headersA })).status()).toBe(401);
        expect((await first.context.request.post('/api/auth/refresh')).status()).toBe(401);
        await testInfo.attach('boundary-checks.json', { body: JSON.stringify({ originAllowed: true, originDenied: true,
            ticketSingleUse: true, protocolCases: corpus.length + 5, distinctActors: true,
            adminDenied: true, foreignSessionDenied: true, logoutRevoked: true, refreshGraceSameSuccessor: true,
            refreshExpiredGraceFamilyRevoked: true, publicGrantAndSessionFieldsOnly: true }), contentType: 'application/json' });
    } finally {
        for (const socket of sockets) socket.terminate();
        await first.context.close(); await second.context.close(); await db.end();
    }
});

test('synthetic result transactions consume issued authority once and transfer only an unplayed grant', async ({}, testInfo) => {
    const db = database();
    try {
        const { drizzle } = require('drizzle-orm/postgres-js');
        const schema = require('../../server-match/dist/database/schema');
        const { ResultService } = require('../../server-match/dist/results/result.service');
        const service = new ResultService(drizzle(db, { schema }));
        const accounts = await Promise.all([0, 1, 2].map(() => seedAccount()));
        const matchId = randomUUID(); const roomId = randomUUID();
        await service.issueMatch(matchId, 'source-worker', 'TestMap1', { id: accounts[0]!.id, nickname: accounts[0]!.nickname, guest: false });
        await service.confirmRoom(matchId, roomId, 'TestMap1');
        for (const account of accounts.slice(1)) await service.addAssignmentByRoom(roomId, { id: account.id, nickname: account.nickname, guest: false });
        const result = { v: 1, matchId, roomId, serverId: 'source-worker', mapId: 'TestMap1',
            startedAt: 1_000, endedAt: 3_000, durationTicks: 60, buildId: 'audit-synthetic-transaction',
            protocolVersion: 2, rulesVersion: 'audit-synthetic', mapBundleHash: 'audit-synthetic', visibilityCoreVersion: 1,
            winnerPlayerIds: [1], replay: null,
            players: accounts.map((account, index) => ({ userId: account.id, nickname: account.nickname,
                playerId: index + 1, colorIndex: index, isGuest: false, tagCount: 0, taggedCount: 0,
                switchTry: 0, switchSuccess: 0, survivedMs: 2_000 })) };
        expect(await service.record({ ...result, serverId: 'unissued-worker' })).toBe('invalid');
        expect((await Promise.all([service.record(result), service.record(result)])).sort()).toEqual(['duplicate', 'stored']);
        const before = await db`select stats from users where id in (${accounts[0]!.id}, ${accounts[1]!.id}, ${accounts[2]!.id}) order by id`;
        expect(before.map(row => row.stats.games)).toEqual([1, 1, 1]);
        expect(await service.record(result)).toBe('duplicate');
        expect(await db`select stats from users where id in (${accounts[0]!.id}, ${accounts[1]!.id}, ${accounts[2]!.id}) order by id`).toEqual(before);
        expect(await db`select player_id from match_participants where match_id=${matchId}`).toHaveLength(3);
        const next = await service.issueNextMatch(result);
        expect(typeof next).toBe('string');
        await service.reassignPendingMatch(next, roomId, 'adopter-worker');
        // A completed row cannot have its result/replay authority rewritten.
        await service.reassignPendingMatch(matchId, roomId, 'adopter-worker');
        const [completed] = await db`select server_id from matches where match_id=${matchId}`;
        expect(completed!.server_id).toBe('source-worker');
        expect(await service.issueNextMatch(result)).toBe(next);
        const successor = { ...result, matchId: next, startedAt: 4_000, endedAt: 6_000 };
        expect(await service.record(successor)).toBe('invalid');
        expect(await service.record({ ...successor, serverId: 'adopter-worker' })).toBe('stored');
        const after = await db`select stats from users where id in (${accounts[0]!.id}, ${accounts[1]!.id}, ${accounts[2]!.id}) order by id`;
        expect(after.map(row => row.stats.games)).toEqual([2, 2, 2]);
        await testInfo.attach('synthetic-database-integrity.json', { body: JSON.stringify({ syntheticInjectedResults: true,
            concurrentSingleCommit: true, duplicateStatsUnchanged: true, participants: 3,
            oldWorkerDeniedAfterGrantTransfer: true, completedAuthorityPreserved: true }), contentType: 'application/json' });
    } finally { await db.end(); }
});
