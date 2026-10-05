import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { database, isolatedContext, login, seedAccount, completeHumanChallenge, watchHumanCheck } from './helpers';

// Solve the displayed instruction from rendered scene geometry/speed labels, without
// importing the service's answer resolver or modifying verification/rate limits.

async function mailCode(page: Page, email: string) {
    let id: string | undefined;
    await expect.poll(async () => {
        const response = await page.request.get(`http://mailpit:8025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
        if (!response.ok()) return false;
        const data = await response.json();
        id = data.messages?.find((message: { Subject?: string; ID: string }) => message.Subject?.includes('회원가입'))?.ID;
        return Boolean(id);
    }, { timeout: 15_000, message: 'synthetic signup SMTP mail arrives in local Mailpit' }).toBe(true);
    const response = await page.request.get(`http://mailpit:8025/api/v1/message/${id}`);
    expect(response.ok(), 'local signup mail is readable').toBe(true);
    const message = await response.json();
    const code = `${message.Text ?? ''}\n${message.HTML ?? ''}`.match(/\b\d{6}\b/)?.[0];
    expect(Boolean(code), 'signup mail contains a six digit verification code').toBe(true);
    return code!;
}

test('synthetic SMTP signup, required consent, login, profile, logout complete successfully', async ({ browser }) => {
    const { context, external } = await isolatedContext(browser);
    const suffix = randomBytes(4).toString('hex');
    const account = { email: `ui${suffix}@switch.test`, nickname: `검증${suffix}`, password: `Au${randomBytes(6).toString('hex')}!` };
    try {
        const page = await context.newPage();
        await page.goto('/signup');
        await page.getByRole('textbox', { name: '이메일', exact: true }).fill(account.email);
        const verification = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/verify');
        const check = watchHumanCheck(page);
        await page.getByRole('button', { name: '코드 발송', exact: true }).click();
        await completeHumanChallenge(page, check);
        expect((await verification).status(), 'synthetic signup verification SMTP request succeeds').toBe(201);
        await expect(page.getByText('인증 코드를 보냈습니다. 5분 안에 입력해 주세요.', { exact: true })).toBeVisible();
        const code = await mailCode(page, account.email);
        await page.getByRole('textbox', { name: '닉네임', exact: true }).fill(account.nickname);
        await page.getByRole('textbox', { name: '인증 코드', exact: true }).fill(code);
        await page.getByLabel('비밀번호', { exact: true }).fill(account.password);
        const signup = page.getByRole('button', { name: '회원가입', exact: true });
        await expect(signup).toBeDisabled();
        await page.getByRole('checkbox', { name: '이용약관에 동의합니다', exact: true }).click();
        await page.getByRole('checkbox', { name: '개인정보처리방침을 확인했습니다', exact: true }).click();
        await expect(signup).toBeDisabled();
        await page.getByRole('checkbox', { name: '만 14세 이상입니다', exact: true }).click();
        await signup.click();
        await expect(page).toHaveURL(/\/login$/);
        await expect(page.getByText('가입이 완료되었습니다. 이제 로그인할 수 있어요.', { exact: true })).toBeVisible();
        const db = database();
        try {
            const [row] = await db`select terms_agreed_at, privacy_agreed_at from users where email = ${account.email}`;
            expect(Boolean(row?.terms_agreed_at && row?.privacy_agreed_at), 'successful signup persists both consents').toBe(true);
        } finally { await db.end(); }
        await login(page, account);
        await page.goto('/profile');
        await expect(page.getByRole('heading', { name: account.nickname, exact: true })).toBeVisible();
        await expect(page.locator('.profile-stat-grid')).toBeVisible();
        await page.getByRole('button', { name: '로그아웃', exact: true }).click();
        await expect(page).toHaveURL('http://web/');
        await page.goto('/profile');
        await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeVisible();
        expect(external, 'browser requests stay within the disposable app').toEqual([]);
    } finally { await context.close(); }
});

test('training applies saved modifier movement and provides keyboard modal closure', async ({ browser }, testInfo) => {
    const { context, external } = await isolatedContext(browser);
    try {
        const page = await context.newPage();
        const responses: { path: string; status: number }[] = [];
        const events: { direction: string; type: string; code?: string }[] = [];
        let pageErrors = 0;
        page.on('pageerror', () => { pageErrors++; });
        page.on('response', response => {
            const path = new URL(response.url()).pathname;
            if (path.startsWith('/api/rooms') || path.includes('/maps') || response.status() >= 400) {
                responses.push({ path, status: response.status() });
            }
        });
        page.on('websocket', socket => {
            const observe = (direction: string) => (frame: { payload: string | Buffer }) => {
                    if (typeof frame.payload !== 'string') return;
                    try {
                        const data = JSON.parse(frame.payload);
                        if (typeof data.type !== 'string' || !/^[a-z.]+$/.test(data.type)) return;
                        const code = typeof data.payload?.code === 'string' && /^[A-Z_]+$/.test(data.payload.code) ? data.payload.code : undefined;
                        events.push({ direction, type: data.type, ...(code ? { code } : {}) });
                    } catch { /* binary snapshots and non-protocol messages carry no diagnostics */ }
            };
            socket.on('framesent', observe('framesent'));
            socket.on('framereceived', observe('framereceived'));
        });
        await page.goto('/training');
        try {
            await expect(page.locator('.game-hud[data-hud-ready="true"]')).toBeVisible({ timeout: 60_000 });
        } catch (error) {
            const crypto = await page.evaluate(() => ({ secure: isSecureContext, subtle: Boolean(globalThis.crypto?.subtle) }));
            const loader: Record<string, boolean> = {};
            for (const text of ['게임 렌더러를 준비하고 있습니다.', '맵을 불러오고 있습니다.', '서버의 경기 시작 신호를 기다리고 있습니다.', '첫 경기 상태를 기다리고 있습니다.', '경기를 준비하지 못했습니다', '맵 로드 실패:']) {
                loader[text] = await page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
            }
            await testInfo.attach('public-training-state', { body: JSON.stringify({ crypto, loader, responses, events, pageErrors, hudCount: await page.locator('.game-hud').count() }), contentType: 'application/json' });
            throw error;
        }
        const marker = page.locator('.training-minimap svg > g > circle').last();
        await expect(marker).toBeVisible();
        const settings = page.getByRole('button', { name: '실시간 설정', exact: true });
        await settings.click();
        const dialog = page.getByRole('dialog', { name: '설정', exact: true });
        await expect(dialog).toBeVisible();
        expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
        await dialog.getByRole('tab', { name: /^04\s*키 맵핑$/ }).click();
        await dialog.getByRole('button', { name: '위로 이동 · 첫 번째 키 · 현재 W', exact: true }).click();
        await page.keyboard.press('Shift+KeyW');
        await expect(dialog.getByRole('button', { name: '위로 이동 · 첫 번째 키 · 현재 Shift+W', exact: true })).toBeVisible();
        const close = dialog.getByRole('button', { name: '설정 닫기', exact: true });
        await close.focus(); await page.keyboard.press('Tab');
        expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(settings).toBeFocused();
        await page.waitForTimeout(300);
        const before = Number(await marker.getAttribute('cy'));
        await page.keyboard.down('KeyW'); await page.waitForTimeout(500); await page.keyboard.up('KeyW');
        expect(Number(await marker.getAttribute('cy'))).toBeCloseTo(before, 1);
        await page.keyboard.down('Shift'); await page.keyboard.down('KeyW');
        await expect.poll(async () => Number(await marker.getAttribute('cy')), { message: 'saved Shift+W moves the rendered server player upwards' }).toBeLessThan(before - 0.25);
        await page.keyboard.up('KeyW'); await page.keyboard.up('Shift');
        await page.getByRole('button', { name: '훈련 종료', exact: true }).click();
        await expect(page).toHaveURL(/\/how-to-play$/);
        expect(external).toEqual([]);
    } finally { await context.close(); }
});

test('resized settings are reachable with keyboard tabs and persist theme and language on reload', async ({ browser }) => {
    const { context, external } = await isolatedContext(browser, { width: 390, height: 844 });
    try {
        const page = await context.newPage();
        await page.goto('/settings');
        const general = page.getByRole('tab', { name: /^01\s*기본 설정$/ });
        await expect(general).toBeVisible();
        await general.focus(); await page.keyboard.press('ArrowDown');
        await expect(page.getByRole('tab', { name: /^02\s*사운드 설정$/ })).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('Home'); await expect(general).toBeFocused();
        await page.getByRole('button', { name: '다크', exact: true }).click();
        await page.getByRole('button', { name: 'English', exact: true }).click();
        await expect(page.locator('html')).toHaveAttribute('lang', 'en');
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute('lang', 'en');
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
            // Desktop Chromium with resized viewports; this does not emulate a phone's
            // touch input, virtual keyboard, physical display or browser zoom.
            await page.setViewportSize(viewport);
            await expect(page.getByRole('tab', { name: /^01\s*General$/ })).toBeVisible();
            await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), {
                message: `settings fit the ${viewport.width}x${viewport.height} viewport horizontally`,
            }).toBe(true);
            await expect(page.locator('html')).toHaveAttribute('lang', 'en');
            await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        }
        expect(external).toEqual([]);
    } finally { await context.close(); }
});

test('synthetic administrator reads live overview and performs an audited synthetic player lookup', async ({ browser }) => {
    const administrator = await seedAccount('ADMIN');
    const target = await seedAccount();
    const { context, external } = await isolatedContext(browser);
    try {
        const page = await context.newPage();
        await login(page, administrator);
        await page.goto('/admin');
        await expect(page.locator('.admin-overview')).toBeVisible();
        const servers = page.locator('section[aria-labelledby="admin-game-servers"]');
        await expect(servers.locator('tbody tr')).not.toHaveCount(0);
        await expect(servers).not.toContainText('등록된 인게임 서버가 없습니다.');
        const refresh = page.getByRole('button', { name: '자동 갱신', exact: true });
        await expect(refresh).toHaveAttribute('aria-pressed', 'true');
        await refresh.click(); await expect(refresh).toHaveAttribute('aria-pressed', 'false');
        await page.getByRole('button', { name: '조회', exact: true }).click();
        await page.getByRole('textbox', { name: '닉네임 또는 계정 id', exact: true }).fill(String(target.id));
        await page.getByRole('button', { name: '찾기', exact: true }).click();
        await expect(page.locator('.admin-lookup-result')).toContainText(target.nickname);
        await expect(page.locator('.admin-lookup-result')).toContainText(`#${target.id}`);
        const audit = page.locator('section[aria-labelledby="admin-audit-title"]');
        const row = audit.getByRole('row').filter({ hasText: `user:${target.id}` });
        await expect(row).toContainText('player.lookup');
        await expect(row).toContainText(`admin:${administrator.id}`);
        expect(external).toEqual([]);
    } finally { await context.close(); }
});
