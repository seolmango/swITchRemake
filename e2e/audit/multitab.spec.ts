import { expect, test } from '@playwright/test';
import { database, isolatedContext, login, seedAccount } from './helpers';

test('same-browser simultaneous account bootstrap preserves both tabs and the live session', async ({ browser }, testInfo) => {
    const account = await seedAccount();
    const { context, external } = await isolatedContext(browser);
    const db = database();
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    let reached!: () => void;
    const barrier = new Promise<void>(done => { reached = done; });
    let waiting = 0;
    let barrierTimer: ReturnType<typeof setTimeout> | undefined;
    const statuses: number[] = [];
    try {
        const first = await context.newPage();
        await login(first, account);
        const second = await context.newPage();
        // Both requests are genuine UI bootstrap fetches with the browser's shared
        // cookie jar. Hold the requests before either can rotate their generation.
        await context.route('**/api/auth/refresh', async route => {
            waiting += 1;
            if (waiting === 2) reached();
            await gate;
            await route.continue();
        });
        for (const page of [first, second]) page.on('response', response => {
            if (new URL(response.url()).pathname === '/api/auth/refresh') statuses.push(response.status());
        });
        const navigations = Promise.all([first.goto('/profile'), second.goto('/profile')]);
        // If the barrier times out, context teardown rejects the pending navigations.
        // Handle that teardown rejection while still propagating it on the normal await.
        void navigations.catch(() => undefined);
        await Promise.race([barrier, new Promise<never>((_done, reject) => {
            barrierTimer = setTimeout(() => reject(new Error('Two UI account bootstraps did not reach the refresh barrier')), 15_000);
        })]);
        clearTimeout(barrierTimer);
        release();
        await navigations;
        for (const page of [first, second]) {
            await expect(page.getByRole('heading', { name: account.nickname, exact: true })).toBeVisible();
            await expect(page.locator('.profile-stat-grid')).toBeVisible();
            await expect(page.getByRole('button', { name: '로그인', exact: true })).toHaveCount(0);
        }
        expect(statuses.sort(), 'both simultaneous UI refresh requests succeed').toEqual([201, 201]);
        const [row] = await db`select count(*)::int as live from sessions where user_id = ${account.id} and revoked_at is null and expires_at > now()`;
        expect(row?.live, 'normal multi-tab bootstrap keeps a live session').toBeGreaterThanOrEqual(1);
        const [reuse] = await db`select count(*)::int as events from auth_security_events where user_id = ${account.id} and event = 'refresh-token-reuse'`;
        expect(reuse?.events, 'normal UI race is not classified as stolen-cookie replay').toBe(0);
        const secure = await first.evaluate(() => ({ secureContext: isSecureContext, webLocks: Boolean(navigator.locks) }));
        await testInfo.attach('multitab-bootstrap-public.json', { contentType: 'application/json',
            body: JSON.stringify({ sameContextTabs: 2, reachedRefreshBarrier: waiting, refreshStatuses: statuses,
                accountVisibleInBothTabs: true, liveSessions: row?.live, reuseEvents: reuse?.events,
                secureContext: secure.secureContext, webLocksAvailable: secure.webLocks }) });
        expect(external).toEqual([]);
    } finally { clearTimeout(barrierTimer); release(); await context.close(); await db.end(); }
});
