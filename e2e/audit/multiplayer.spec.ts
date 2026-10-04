import { test, expect, type Browser, type Page } from '@playwright/test';
import { decodeSnapshot, type Snapshot } from 'shared';
import { apiLogin, database, isolatedContext, login, seedAccount } from './helpers';

test('three member browsers complete two games, persist results and stats, download replay and leave', async ({ playwright }, testInfo) => {
    test.setTimeout(420_000);
    const db = database();
    const playerBrowsers: Browser[] = [];
    const clients: Array<Awaited<ReturnType<typeof isolatedContext>> & {
        account: Awaited<ReturnType<typeof seedAccount>>; page: Page; frames: Snapshot[];
        eventTypes: string[]; errors: string[]; headers: { Authorization: string };
        input: { total: number; moving: number; textFrames: number; binaryFrames: number };
    }> = [];
    const matchIds: string[] = [];
    const evidence: object[] = [];
    let reportCaseId = '';
    try {
        for (let index = 0; index < 3; index++) {
            const account = await seedAccount();
            const playerBrowser = await playwright.chromium.launch({ channel: 'chromium',
                args: ['--mute-audio', '--unsafely-treat-insecure-origin-as-secure=http://web'] });
            playerBrowsers.push(playerBrowser);
            const isolated = await isolatedContext(playerBrowser, { width: 1280, height: 720 });
            const page = await isolated.context.newPage();
            const frames: Snapshot[] = [];
            const eventTypes: string[] = [];
            const errors: string[] = [];
            const input = { total: 0, moving: 0, textFrames: 0, binaryFrames: 0 };
            page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
                if (typeof payload === 'string') input.textFrames++; else input.binaryFrames++;
                if (typeof payload !== 'string' && payload.length === 6) { input.total++; if (payload[4]) input.moving++; }
            }));
            page.on('pageerror', () => errors.push('pageerror'));
            page.on('console', message => {
                if (message.type() === 'error' && message.text().includes('[swITch] snapshot apply failed')) errors.push('snapshot-apply-failed');
            });
            page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
                if (typeof payload === 'string') {
                    try { const event = JSON.parse(payload); if (event.type !== 'pong') eventTypes.push(event.type); } catch { errors.push('invalid JSON'); }
                } else {
                    try {
                        const value = decodeSnapshot(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer);
                        if (frames.length < 12_000) frames.push(value);
                    } catch { errors.push('invalid snapshot'); }
                }
            }));
            const headers = await login(page, account);
            // Exercise supported low-power controls for software-rendered CI.
            // The game, input cadence, map, rules and result pipeline are real.
            await page.goto('/settings');
            await page.getByRole('tab', { name: /^03\s*인게임 설정$/ }).click();
            for (const [label, value] of [['프레임 설정', '30'], ['그래픽 품질', '낮음'], ['렌더 해상도', '75%']]) {
                const control = page.locator('.settings-row').filter({ has: page.getByText(label!, { exact: true }) }).getByRole('button', { name: value, exact: true });
                await control.click();
                await expect(control).toHaveAttribute('aria-pressed', 'true');
            }
            clients.push({ ...isolated, account, page, frames, eventTypes, errors, headers, input });
        }
        expect(new Set(clients.map(client => client.account.id)).size).toBe(3);
        const browser = playerBrowsers[0]!;
        const host = clients[0]!.page;
        expect(await host.evaluate(() => ({ secure: isSecureContext, webcrypto: !!crypto.subtle })),
            'isolated browser must provide the cryptography APIs available on production HTTPS').toEqual({ secure: true, webcrypto: true });
        await host.goto('/rooms/create');
        await host.getByRole('textbox', { name: '방 이름', exact: true }).fill('독립검증경기');
        await host.getByRole('button', { name: '방 만들기', exact: true }).click();
        await host.waitForURL('**/lobby');
        const roomId = new URL(host.url()).pathname.split('/')[2]!;
        const map = host.locator('.lobby-map-picker strong');
        await expect(map).toHaveText(/BattleField|TestMap1/);
        if (await map.innerText() !== 'TestMap1') await host.getByRole('button', { name: '다음 맵', exact: true }).click();
        await expect(map).toHaveText('TestMap1');
        const code = (await host.locator('.lobby-room-code strong').innerText()).trim();
        for (const client of clients.slice(1)) {
            await client.page.goto('/rooms/join');
            await client.page.getByLabel('방 코드', { exact: true }).fill(code);
            await client.page.getByRole('button', { name: '코드로 참가', exact: true }).click();
            await client.page.waitForURL('**/lobby');
        }
        for (const client of clients) await expect(client.page.locator('.lobby-player-card:not(.is-empty)')).toHaveCount(3);
        await host.screenshot({ path: testInfo.outputPath('three-synthetic-members.png') });
        for (let round = 1; round <= 2; round++) {
            const movingBefore = clients.map(client => client.input.moving);
            for (const client of clients) { client.frames.length = 0; client.eventTypes.length = 0; }
            const resultResponses = clients.map(client => client.page.waitForResponse(async response => {
                if (!/\/api\/matches\/[^/]+\/result$/.test(new URL(response.url()).pathname) || response.status() !== 200) return false;
                return Array.isArray((await response.json()).players);
            }, { timeout: 180_000 }).then(async response => {
                const data = await response.json();
                const visibleState = await client.page.evaluate(() => ({ browserNow: Date.now(),
                    returnsAt: Number(new URL(location.href).searchParams.get('returns_at')),
                    errorBoundary: document.body.innerText.includes('화면을 표시하지 못했습니다'),
                    resultShell: !!document.querySelector('.result-shell') }));
                evidence.push({ round, member: clients.indexOf(client) + 1, phase: 'result-api', at: Date.now(), path: new URL(client.page.url()).pathname, ...visibleState });
                // Each result is displayed for ten seconds. Verify it when that
                // browser receives it, without waiting for other clients' HTTP.
                await expect(client.page.locator('.result-table tbody tr')).toHaveCount(3);
                for (const player of data.players) await expect(client.page.locator('.result-table')).toContainText(player.nickname);
                if (client === clients[0]) await client.page.screenshot({ path: testInfo.outputPath(`round-${round}-result.png`) });
                return data;
            }));
            // Observe cancellation on an earlier assertion failure without hiding
            // any result error from the awaited promises below.
            for (const response of resultResponses) void response.catch(() => undefined);
            const start = host.locator('.lobby-footer-actions button').last();
            await expect(start).toBeEnabled();
            await start.click();
            await Promise.all(clients.map(client => expect(client.page.locator('.game-hud[data-hud-ready="true"]')).toBeVisible({ timeout: 30_000 })));
            await expect.poll(() => clients.every(client => client.eventTypes.includes('game.started')),
                { timeout: 30_000, message: 'all three players finish preparation and enter the running game' }).toBe(true);
            // Each player owns a separate browser process and keyboard focus.
            for (const key of ['d', 's', 'a', 'w']) {
                await Promise.all(clients.map(client => client.page.keyboard.down(key)));
                await host.waitForTimeout(650);
                await Promise.all(clients.map(client => client.page.keyboard.up(key)));
            }
            await Promise.all(clients.map(client => client.page.keyboard.press('Space')));
            for (const client of clients) {
                expect(client.frames[0]?.full).toBe(true);
                expect(client.frames[0]?.map).toBeDefined();
                expect(client.frames[0]?.roster).toHaveLength(3);
                const selfId = client.frames[0]!.selfId;
                expect(client.input.moving, 'the real browser sent directional input in this round').toBeGreaterThan(movingBefore[clients.indexOf(client)]!);
                await expect.poll(() => new Set(client.frames.flatMap(frame => frame.players?.filter(player => player.id === selfId).map(player => `${player.x},${player.y}`) ?? [])).size,
                    { message: `round ${round}, member ${clients.indexOf(client) + 1}: authoritative movement`, timeout: 15_000 }).toBeGreaterThan(1);
            }
            const results = await Promise.all(resultResponses);
            const result = results[0];
            const matchId: string = result.matchId;
            expect(matchIds).not.toContain(matchId);
            matchIds.push(matchId);
            for (let index = 0; index < clients.length; index++) {
                const client = clients[index]!;
                expect(results[index].matchId).toBe(matchId);
                expect(results[index].players.filter((player: {isSelf: boolean}) => player.isSelf)).toHaveLength(1);
                expect(results[index].players.find((player: {isSelf: boolean}) => player.isSelf).nickname).toBe(client.account.nickname);
                expect(results[index].winners).toEqual(result.winners);
                expect(results[index].reward.breakdown.total).toBeGreaterThanOrEqual(40);
            }
            const rows = await db`select * from match_participants where match_id=${matchId} order by player_id`;
            expect(rows).toHaveLength(3);
            const [stored] = await db`select result_recorded_at, duration_ticks from matches where match_id=${matchId}`;
            expect(stored!.result_recorded_at).not.toBeNull();
            expect(stored!.duration_ticks).toBeGreaterThan(0);
            for (const row of rows) {
                const player = result.players.find((p: {playerId: string}) => p.playerId === String(row.player_id));
                expect(player).toMatchObject({ nickname: row.nickname, tagCount: row.tag_count, taggedCount: row.tagged_count,
                    switchTry: row.switch_try, switchSuccess: row.switch_success, survivedMs: row.survived_ms, isGuest: false });
                expect(result.winners.includes(String(row.player_id))).toBe(row.is_winner);
                const [user] = await db`select stats from users where id=${row.user_id}`;
                expect(user!.stats.games).toBe(round);
                const expected = await db`select coalesce(sum(40 + case when is_winner then 60 else 0 end + 20*tag_count + 15*switch_success + floor(least(survived_ms,600000)*12.0/60000)),0)::integer as xp from match_participants where user_id=${row.user_id}`;
                expect(user!.stats.xp).toBe(expected[0]!.xp);
            }
            if (round === 2) {
                // A real completed game supplies the report evidence; no result fixture.
                await host.getByRole('button', { name: `${clients[1]!.account.nickname} 신고하기`, exact: true }).click();
                const report = host.getByRole('dialog');
                await report.getByRole('button', { name: '부적절한 행위', exact: true }).click();
                await report.getByRole('textbox').fill('격리된 합성 경기의 정상 신고 처리 검증입니다.');
                const posted = host.waitForResponse(response => new URL(response.url()).pathname === '/api/reports' && response.request().method() === 'POST');
                await report.getByRole('button', { name: '신고 보내기', exact: true }).click();
                const response = await posted;
                expect(response.status()).toBe(201);
                reportCaseId = (await response.json()).caseId;
                await expect(report.getByText('신고를 접수했습니다. 확인에는 시간이 걸립니다.', { exact: true })).toBeVisible();
                await report.getByRole('button', { name: '닫기', exact: true }).click();
            }
            evidence.push({ round, matchId, participants: rows.length, resultPersisted: true,
                independentSessions: 3, authoritativeMovement: true, statsAndXpExact: true });
            await Promise.all(clients.map(client => client.page.waitForURL('**/lobby', { timeout: 30_000 })));
        }
        // Leave through the product; the next player must acquire host privileges.
        await host.getByRole('button', { name: '방 나가기', exact: true }).click();
        await host.waitForURL('**/rooms');
        await expect(clients[1]!.page.locator('.lobby-map-picker button').first()).toBeEnabled();
        for (const client of clients.slice(1)) {
            await client.page.getByRole('button', { name: '방 나가기', exact: true }).click();
            await client.page.waitForURL('**/rooms');
        }
        const owner = clients[0]!;
        const history = await owner.context.request.get('/api/users/me/matches', { headers: owner.headers });
        expect(history.status()).toBe(200);
        expect(JSON.stringify(await history.json())).toContain(matchIds[1]);
        const ticketResponse = await owner.context.request.post(`/api/users/me/matches/${matchIds[1]}/replay-ticket`, { headers: owner.headers });
        expect(ticketResponse.status()).toBe(201);
        const ticket = await ticketResponse.json();
        const download = await owner.context.request.get(ticket.path);
        expect(download.status()).toBe(200);
        const replay = await download.body();
        expect(replay.length).toBeGreaterThan(128);
        const repeated = await owner.context.request.get(ticket.path);
        expect([401, 403, 404]).toContain(repeated.status());
        await host.goto('/replay');
        await host.locator('input[type=file]').setInputFiles({ name: 'audit.switchreplay', mimeType: 'application/octet-stream', buffer: replay });
        await expect(host.locator('.replay-verdict')).toContainText('검증됨');
        await expect(host.locator('.replay-participants li')).toHaveCount(3);
        await expect(host.locator('.replay-meta dl > div').filter({ has: host.getByText('길이', { exact: true }) }).locator('dd')).not.toHaveText('불러오는 중…');
        await expect(host.locator('.replay-stage canvas')).toBeVisible();
        await expect(host.getByRole('button', { name: '재생', exact: true })).toBeEnabled();
        const seek = host.getByRole('slider', { name: '재생 위치', exact: true });
        const finalFrame = Number(await seek.getAttribute('max'));
        expect(finalFrame, 'the actual completed match contains a replay timeline').toBeGreaterThan(10);
        await host.getByRole('button', { name: '재생', exact: true }).click();
        await expect.poll(async () => Number(await seek.inputValue()), { message: 'replay advances actual recorded frames' }).toBeGreaterThan(0);
        await host.getByRole('button', { name: '멈춤', exact: true }).click();
        const pausedFrame = await seek.inputValue();
        await host.waitForTimeout(500);
        expect(await seek.inputValue(), 'pause retains the same recorded frame').toBe(pausedFrame);
        await seek.focus(); await seek.press('End');
        await expect(seek).toHaveValue(String(finalFrame));
        await expect(host.locator('.replay-position')).toHaveText(`${finalFrame + 1} / ${finalFrame + 1}`);
        await seek.press('Home');
        await expect(seek).toHaveValue('0');
        await expect(host.locator('.replay-position')).toHaveText(`1 / ${finalFrame + 1}`);
        evidence.push({ replaySignatureVerified: true, replayParticipants: 3, replayFrames: finalFrame + 1,
            playbackAdvanced: true, pauseHeld: true, seekForwardAndBackward: true });
        const denied = await owner.context.request.get('/api/admin/overview', { headers: owner.headers });
        expect(denied.status()).toBe(403);
        expect((await owner.context.request.get(`/api/admin/reports/${reportCaseId}`, { headers: owner.headers })).status()).toBe(403);
        const admin = await isolatedContext(browser);
        try {
            const adminAccount = await seedAccount('ADMIN');
            const page = await admin.context.newPage();
            const headers = await login(page, adminAccount);
            await page.goto('/admin');
            await page.getByRole('button', { name: '신고', exact: true }).click();
            await page.locator('.admin-report-row').filter({ hasText: clients[1]!.account.nickname }).click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toContainText('격리된 합성 경기의 정상 신고 처리 검증입니다.');
            await expect(dialog).toContainText('리플레이 보존 중');
            await dialog.locator('select').first().selectOption('TRIAGED');
            await dialog.getByRole('button', { name: '적용', exact: true }).click();
            await expect(dialog.locator('.admin-case-header')).toContainText('분류됨');
            await dialog.getByLabel('사유 — 감사 로그에 남습니다', { exact: true }).fill('격리 합성 계정에 대한 감사용 경고입니다.');
            await dialog.getByRole('button', { name: '제재 걸기', exact: true }).click();
            await expect(dialog.getByText('제재를 걸었습니다.', { exact: true })).toBeVisible();
            const [moderation] = await db`select status, report_count from moderation_cases where id=${reportCaseId}`;
            expect(moderation).toMatchObject({ status: 'ACTIONED', report_count: 1 });
            const sanctions = await db`select type, user_id from sanctions where evidence_match_id=${matchIds[1]}`;
            expect(sanctions).toEqual([{ type: 'WARN', user_id: clients[1]!.account.id }]);
            const audit = await db`select action from admin_audit_log where target_id=${reportCaseId}`;
            expect(audit.map(row => row.action)).toEqual(expect.arrayContaining(['report.status', 'report.sanction']));
            const duplicate = await admin.context.request.post(`/api/admin/reports/${reportCaseId}/sanction`, {
                headers, data: { type: 'WARN', reason: '동일 사건 중복 제재 방지를 확인합니다.' },
            });
            expect(duplicate.status()).toBe(409);
            expect((await db`select id from sanctions where evidence_match_id=${matchIds[1]}`)).toHaveLength(1);
            evidence.push({ reportSubmittedByBrowser: true, moderatorUiProcessed: true, duplicateSanctionDenied: true, auditPersisted: true });
            expect(admin.external).toEqual([]);
        } finally { await admin.context.close(); }
        const outsider = await isolatedContext(browser);
        try {
            const outsideHeaders = await apiLogin(outsider.context, await seedAccount());
            expect((await outsider.context.request.get(`/api/matches/${matchIds[1]}/result`, { headers: outsideHeaders })).status()).toBe(403);
            expect((await outsider.context.request.post(`/api/users/me/matches/${matchIds[1]}/replay-ticket`, { headers: outsideHeaders })).status()).toBe(403);
            // The saved file is portable, while server downloads remain participant-only.
            // Bound malformed input to 32 bytes, then prove the same page can recover.
            const reader = await outsider.context.newPage();
            await reader.goto('/replay');
            await reader.locator('input[type=file]').setInputFiles({ name: 'invalid.swrp', mimeType: 'application/octet-stream', buffer: Buffer.alloc(32) });
            await expect(reader.getByRole('alert')).toContainText('읽을 수 없는 파일');
            await reader.locator('input[type=file]').setInputFiles({ name: 'valid.swrp', mimeType: 'application/octet-stream', buffer: replay });
            await expect(reader.locator('.replay-verdict')).toContainText('검증됨');
            await expect(reader.locator('.replay-participants li')).toHaveCount(3);
            await expect(reader.getByRole('slider', { name: '재생 위치', exact: true })).toHaveAttribute('max', String(finalFrame));
            expect(outsider.external).toEqual([]);
            evidence.push({ malformedReplayBytes: 32, rejectedWithVisibleError: true, validFileRecovery: true });
        } finally { await outsider.context.close(); }
        const anonymous = await browser.newContext({ baseURL: 'http://web' });
        try { expect((await anonymous.request.get(`/api/matches/${matchIds[1]}/result`)).status()).toBe(401); }
        finally { await anonymous.close(); }
        await expect.poll(async () => {
            const rooms = await owner.context.request.get('/api/rooms', { headers: owner.headers });
            expect(rooms.status()).toBe(200);
            return JSON.stringify(await rooms.json()).includes(roomId);
        }, { intervals: [1000], timeout: 15_000, message: 'departed room disappears from server directory' }).toBe(false);
        for (const client of clients) { expect(client.external).toEqual([]); expect(client.errors).toEqual([]); }
        await testInfo.attach('sanitized-outcomes', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    } finally {
        await testInfo.attach('phase-diagnostics', { body: JSON.stringify({ evidence,
            pages: clients.map(client => ({ path: new URL(client.page.url()).pathname })) }), contentType: 'application/json' });
        await testInfo.attach('movement-diagnostics', { body: JSON.stringify(clients.map((client, index) => ({
            member: index + 1, input: client.input, errors: client.errors, events: [...new Set(client.eventTypes)],
            frames: client.frames.length, firstTick: client.frames[0]?.tick, lastTick: client.frames.at(-1)?.tick,
            selfId: client.frames[0]?.selfId, positions: new Set(client.frames.flatMap(frame => frame.players?.filter(player => player.id === client.frames[0]?.selfId).map(player => `${player.x},${player.y}`) ?? [])).size,
        }))), contentType: 'application/json' });
        for (const client of clients) await client.context.close();
        for (const playerBrowser of playerBrowsers) await playerBrowser.close();
        await db.end();
    }
});
