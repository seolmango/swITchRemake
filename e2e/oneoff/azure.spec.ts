import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { decodeSnapshot, type Snapshot } from 'shared';
import { readFileSync, writeFileSync } from 'node:fs';

// One room, three independent guests, one serial task, normal UI input only.
test('limited live batch: private room, three isolated players, two complete rounds and cleanup', async ({ browser }, info) => {
    const origin = 'https://switch-dev-193234.koreacentral.cloudapp.azure.com';
    const members: { email: string; password: string; registered: boolean }[] = process.env.AUDIT_LIVE_ACCOUNTS
        ? JSON.parse(readFileSync(process.env.AUDIT_LIVE_ACCOUNTS, 'utf8')) : [];
    if (members.length && (members.length !== 2 || members.some(member => !member.registered))) throw new Error('Exactly two newly registered owner test accounts required');
    const clients: { context: BrowserContext; page: Page; frames: Snapshot[]; events: string[]; positions: Set<string>; headers?: { Authorization: string } }[] = [];
    const outcomes: object[] = [];
    let halted = false;
    let serverErrorStreak = 0;
    const counts = { static: 0, api: 0, websocketSent: 0, websocketConnections: 0 };
    let separateHttp = 0;
    const extraOrigins: string[] = [];
    const started = Date.now();
    try {
        for (let index = 0; index < 3; index++) {
            const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
            await context.addInitScript(() => localStorage.setItem('switch-settings', JSON.stringify({ version: 2, state: { masterVolume: 0, bgmEnabled: false } })));
            await context.route('**/*', async route => {
                const url = new URL(route.request().url());
                if (url.origin !== origin) { extraOrigins.push(url.origin); return route.abort(); }
                if (halted) return route.abort();
                counts[url.pathname.startsWith('/api/') ? 'api' : 'static']++;
                return route.continue();
            });
            const page = await context.newPage();
            const frames: Snapshot[] = [];
            const events: string[] = [];
            let selfId = 0;
            const positions = new Set<string>();
            page.on('response', response => {
                if (response.status() >= 500) serverErrorStreak++; else if (response.status() < 400) serverErrorStreak = 0;
                if (response.status() === 429 || serverErrorStreak >= 2) { halted = true; void Promise.all(clients.map(client => client.context.close())); }
            });
            page.on('websocket', socket => {
                counts.websocketConnections++;
                socket.on('framesent', () => counts.websocketSent++);
                socket.on('framereceived', ({ payload }) => {
                    if (typeof payload === 'string') {
                        try { const event = JSON.parse(payload); if (event.type !== 'pong') events.push(event.type); } catch { /* opaque invalid frame */ }
                    } else {
                        const frame = decodeSnapshot(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer);
                        if (frame.full && frames.length < 10) frames.push(frame);
                        if (frame.selfId) selfId = frame.selfId;
                        for (const player of frame.players ?? []) if (player.id === selfId) positions.add(`${player.x},${player.y}`);
                    }
                });
            });
            let headers: { Authorization: string } | undefined;
            if (members[index]) {
                await page.goto('/login');
                await page.getByRole('textbox', { name: '이메일', exact: true }).fill(members[index]!.email);
                await page.getByLabel('비밀번호', { exact: true }).fill(members[index]!.password);
                const loggedIn = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login');
                await page.getByRole('button', { name: '로그인', exact: true }).click();
                const response = await loggedIn;
                expect(response.status()).toBe(201);
                const data = await response.json();
                if (typeof data.accessToken !== 'string') throw new Error('New synthetic member login failed');
                headers = { Authorization: `Bearer ${data.accessToken}` };
            } else await page.goto('/');
            page.on('request', request => {
                const url = new URL(request.url()), authorization = request.headers()['authorization'];
                if (headers && url.origin === origin && url.pathname.startsWith('/api/') && authorization?.startsWith('Bearer ')) headers.Authorization = authorization;
            });
            clients.push({ context, page, frames, events, positions, headers });
            await expect(page.getByRole('button', { name: '게임 시작', exact: true })).toBeVisible();
            console.log(`Isolated ${members[index] ? 'member' : 'guest'} ${index + 1} ready; sound muted`);
        }
        const host = clients[0]!.page;
        await host.goto('/rooms/create');
        await host.getByRole('textbox', { name: '방 이름', exact: true }).fill('소유자독립검증');
        await host.getByRole('checkbox').check();
        await host.getByLabel('방 비밀번호', { exact: true }).fill('7462');
        await host.getByRole('button', { name: '방 만들기', exact: true }).click();
        await host.waitForURL('**/lobby');
        const map = host.locator('.lobby-map-picker strong');
        await expect(map).toHaveText(/BattleField|TestMap1/);
        if (await map.innerText() !== 'TestMap1') await host.getByRole('button', { name: '다음 맵', exact: true }).click();
        await expect(map).toHaveText('TestMap1');
        const code = (await host.locator('.lobby-room-code strong').innerText()).trim();
        for (const client of clients.slice(1)) {
            await client.page.goto('/rooms/join');
            await client.page.getByLabel('방 코드', { exact: true }).fill(code);
            await client.page.getByLabel('방 비밀번호', { exact: true }).fill('7462');
            await client.page.getByRole('button', { name: '코드로 참가', exact: true }).click();
            await client.page.waitForURL('**/lobby');
        }
        for (const client of clients) await expect(client.page.locator('.lobby-player-card:not(.is-empty)')).toHaveCount(3);
        console.log('One private room, three independent players confirmed');
        for (let round = 1; round <= 2; round++) {
            if (halted) throw new Error('Safety stop');
            for (const client of clients) { client.frames.length = 0; client.positions.clear(); }
            const resultResponses = clients.map(client => client.page.waitForResponse(async response => {
                if (!/\/api\/matches\/[^/]+\/result$/.test(new URL(response.url()).pathname) || response.status() !== 200) return false;
                return Array.isArray((await response.json()).players);
            }, { timeout: 180_000 }));
            const start = host.locator('.lobby-footer-actions button').last();
            await expect(start).toBeEnabled();
            await start.click();
            await Promise.all(clients.map(client => expect(client.page.locator('.game-hud[data-hud-ready="true"]')).toBeVisible({ timeout: 30_000 })));
            for (const key of ['d', 's', 'a', 'w']) {
                await Promise.all(clients.map(client => client.page.keyboard.down(key)));
                await host.waitForTimeout(650);
                await Promise.all(clients.map(client => client.page.keyboard.up(key)));
            }
            await Promise.all(clients.map(client => client.page.keyboard.press('Space')));
            for (const client of clients) { expect(client.frames[0]?.full).toBe(true); expect(client.frames[0]?.roster).toHaveLength(3); expect(client.positions.size).toBeGreaterThan(1); }
            console.log(`Round ${round}: three authoritative full states and movement confirmed`);
            const results = await Promise.all((await Promise.all(resultResponses)).map(response => response.json()));
            const matchId = results[0].matchId;
            for (let index = 0; index < clients.length; index++) {
                expect(results[index].matchId).toBe(matchId);
                expect(results[index].players).toHaveLength(3);
                expect(results[index].players.filter((p: {isSelf:boolean}) => p.isSelf)).toHaveLength(1);
                expect(results[index].winners).toEqual(results[0].winners);
                await expect(clients[index]!.page.locator('.result-table tbody tr')).toHaveCount(3);
            }
            outcomes.push({ round, matchId, authoritativeMovement: true, allThreeResultTables: true, persistedApiResult: true });
            await host.screenshot({ path: info.outputPath(`round-${round}-synthetic-result.png`) });
            await Promise.all(clients.map(client => client.page.waitForURL('**/lobby', { timeout: 30_000 })));
            console.log(`Round ${round}: results agreed and all three returned to lobby`);
        }
        for (const client of clients) { await client.page.getByRole('button', { name: '방 나가기', exact: true }).click(); await client.page.waitForURL('**/rooms'); }
        if (members.length) {
            // Only the newly created owner accounts. No unrelated IDs are queried.
            const request = async (index: number, path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET') => {
                if (halted) throw new Error('Safety stop');
                await host.waitForTimeout(1_100);
                separateHttp++;
                const response = await clients[index]!.context.request.fetch(path, { method, headers: clients[index]!.headers, timeout: 10_000 });
                if (response.status() === 429 || response.status() >= 500) { halted = true; throw new Error('Safety stop on separate API response'); }
                return response;
            };
            for (let index = 0; index < 2; index++) {
                const stats = await request(index, '/api/users/me/stats');
                expect(stats.status()).toBe(200);
                expect((await stats.json()).games).toBe(2);
                const history = await request(index, '/api/users/me/matches');
                expect(history.status()).toBe(200);
                for (const result of outcomes as {matchId:string}[]) expect(JSON.stringify(await history.json())).toContain(result.matchId);
                expect((await request(index, '/api/admin/overview')).status()).toBe(403);
            }
            const own = await request(0, '/api/users/me/sessions');
            expect(own.status()).toBe(200);
            const ownSession = (await own.json()).sessions.find((session: {current:boolean}) => session.current);
            if (!ownSession || typeof ownSession.id !== 'string') throw new Error('Own synthetic session missing');
            expect((await request(1, `/api/users/me/sessions/${ownSession.id}`, 'DELETE')).status()).toBe(404);
            expect((await request(0, '/api/users/me/stats')).status()).toBe(200);
            outcomes.push({ memberStatsGames: 2, historyContainsBothMatches: true, memberAdminDenied: true, foreignSyntheticSessionDenied: true });
        }
        expect(extraOrigins).toEqual([]);
        console.log('All three players left through UI; no destructive teardown');
    } finally {
        const evidence = JSON.stringify({ startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, halted, members: members.length, guests: 3 - members.length, counts, separateHttp, outcomes });
        writeFileSync(info.outputPath('sanitized-outcomes.json'), evidence);
        await info.attach('sanitized-live-outcomes', { body: evidence, contentType: 'application/json' });
        for (const client of clients) await client.context.close().catch(() => {});
    }
});
