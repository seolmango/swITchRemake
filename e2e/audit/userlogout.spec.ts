import { expect, test } from '@playwright/test';
import { database, isolatedContext, login, seedAccount } from './helpers';

test('interrupted logout preserves account and reports failure until a real retry revokes the cookie session', async ({ browser }, testInfo) => {
    await new Promise<void>(done => setTimeout(done, 61_000));
    const account = await seedAccount();
    const { context, external } = await isolatedContext(browser);
    const db = database();
    const active = async () => {
        const [row] = await db`select count(*)::int as active from sessions
            where user_id = ${account.id} and revoked_at is null and expires_at > now()`;
        return row!.active as number;
    };
    try {
        const page = await context.newPage();
        await login(page, account);
        await page.goto('/profile');
        await expect(page.getByRole('heading', { name: account.nickname, exact: true })).toBeVisible();
        let interrupted = 0;
        // Inject only the outgoing logout transport failure; auth, guest issuance,
        // refresh, the database and every other browser request stay real.
        await page.route('http://web/api/auth/logout', route => { interrupted++; return route.abort('connectionfailed'); });
        await page.locator('.profile-actions').getByRole('button', { name: '로그아웃', exact: true }).click();
        await expect(page.getByText('서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.', { exact: true })).toBeVisible();
        await expect(page).toHaveURL('http://web/profile');
        await expect(page.getByRole('heading', { name: account.nickname, exact: true })).toBeVisible();
        expect(interrupted).toBe(1);
        expect(await active(), 'a transport failure has not revoked the real account session').toBe(1);

        const retained = await context.newPage();
        await retained.goto('/profile');
        await expect(retained.getByRole('heading', { name: account.nickname, exact: true })).toBeVisible();
        await retained.close();

        await page.unroute('http://web/api/auth/logout');
        const acknowledged = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout' && response.status() === 201);
        await page.locator('.profile-actions').getByRole('button', { name: '로그아웃', exact: true }).click();
        await acknowledged;
        await expect(page).toHaveURL('http://web/');
        expect(await active(), 'acknowledged logout revokes the real cookie session').toBe(0);
        const fresh = await context.newPage();
        await fresh.goto('/profile');
        await expect(fresh.getByRole('button', { name: '로그인', exact: true })).toBeVisible();
        await expect(fresh.getByRole('heading', { name: account.nickname, exact: true })).toHaveCount(0);
        expect(external).toEqual([]);
        await testInfo.attach('public-logout-state', { body: JSON.stringify({ interruptedRequests: interrupted,
            failedLogoutAccountPreserved: true, failedLogoutCookieStillLive: true,
            retryServerAcknowledged: true, retryActiveSessions: 0, freshTabGuest: true }), contentType: 'application/json' });
    } finally { await context.close(); await db.end(); }
});
