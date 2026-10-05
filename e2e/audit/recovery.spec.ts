import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { database, isolatedContext, login, seedAccount, completeHumanChallenge, watchHumanCheck } from './helpers';
import { authenticatorCode, localAuthenticator } from './totp';

async function logout(page: Page) {
    await page.goto('/profile');
    await page.locator('.profile-actions').getByRole('button', { name: '로그아웃', exact: true }).click();
    await expect(page).toHaveURL('http://web/');
}
async function security(page: Page) {
    await page.goto('/settings');
    await page.getByRole('tab', { name: /^05\s*계정 보안$/ }).click();
    await expect(page.getByText('2차 인증 상태', { exact: true })).toBeVisible();
}
async function resetMailCode(page: Page, email: string) {
    let id: string | undefined;
    await expect.poll(async () => {
        const response = await page.request.get(`http://mailpit:8025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
        if (!response.ok()) return false;
        const data = await response.json();
        id = data.messages?.find((message: { Subject?: string; ID: string }) => message.Subject?.includes('비밀번호 재설정'))?.ID;
        return Boolean(id);
    }, { message: 'synthetic password reset mail arrives through local SMTP', timeout: 15_000 }).toBe(true);
    const response = await page.request.get(`http://mailpit:8025/api/v1/message/${id}`);
    expect(response.ok(), 'local reset mail is readable').toBe(true);
    const data = await response.json();
    const code = `${data.Text ?? ''}\n${data.HTML ?? ''}`.match(/\b\d{6}\b/)?.[0];
    expect(Boolean(code), 'reset mail carries a verification code').toBe(true);
    return code!;
}

test('local independent TOTP authenticator matches a public RFC test vector', () => {
    expect(authenticatorCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082');
});

test('extended UI TOTP setup, login, SMTP password recovery and MFA removal succeed', async ({ browser }, testInfo) => {
    test.setTimeout(360_000);
    await new Promise<void>(done => setTimeout(done, 61_000));
    const account = await seedAccount();
    const recovered = { ...account, password: `Re${randomBytes(6).toString('hex')}!` };
    const { context, external } = await isolatedContext(browser);
    const db = database();
    const evidence: { path: string; status: number; code?: string; mfaRequired?: boolean; tokenIssued?: boolean }[] = [];
    const observing: Promise<void>[] = [];
    try {
        const page = await context.newPage();
        page.on('response', response => {
            const path = new URL(response.url()).pathname;
            if (!path.startsWith('/api/auth/')) return;
            observing.push((async () => {
                const data = await response.json().catch(() => ({}));
                evidence.push({ path, status: response.status(),
                    ...(typeof data.code === 'string' && /^[A-Z_]+$/.test(data.code) ? { code: data.code } : {}),
                    ...(typeof data.mfaRequired === 'boolean' ? { mfaRequired: data.mfaRequired } : {}),
                    tokenIssued: typeof data.accessToken === 'string',
                });
            })());
        });
        await login(page, account);
        await security(page);
        await page.getByRole('radio').filter({ hasText: 'OTP' }).click();
        await page.getByLabel('현재 비밀번호', { exact: true }).fill(account.password);
        await page.getByRole('button', { name: 'OTP 등록 시작', exact: true }).click();
        const setup = page.locator('.mfa-secret-card');
        await expect(setup).toBeVisible(); await expect(setup.locator('svg')).toBeVisible();
        const secret = (await setup.locator('code').textContent())?.trim();
        expect(Boolean(secret), 'TOTP enrollment displays a local secret once').toBe(true);
        const authenticator = localAuthenticator(secret!);
        await setup.getByLabel('2차 인증 코드', { exact: true }).fill(await authenticator.nextCode());
        await setup.getByRole('button', { name: '확인', exact: true }).click();
        const backup = page.getByRole('region', { name: '백업 코드를 저장하세요', exact: true });
        await expect(backup.locator('code')).toHaveCount(10);
        await backup.getByRole('checkbox', { name: '안전한 곳에 저장했습니다', exact: true }).click();
        await backup.getByRole('button', { name: '완료', exact: true }).click();
        await expect(page.getByText('켜짐', { exact: true })).toBeVisible();
        const [stored] = await db`select method = 'totp' as totp, totp_secret_encrypted like 'v1:%' as encrypted,
            last_totp_step is not null as replay_guard from mfa_settings where user_id = ${account.id}`;
        expect(stored, 'confirmed TOTP persists an encrypted secret and consumed time step').toMatchObject({ totp: true, encrypted: true, replay_guard: true });
        await logout(page);

        const totpLogin = async (password: string) => {
            await page.goto('/login');
            await page.getByLabel('이메일', { exact: true }).fill(account.email);
            await page.getByLabel('비밀번호', { exact: true }).fill(password);
            const submitted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login');
            await page.getByRole('button', { name: '로그인', exact: true }).click();
            const response = await submitted;
            expect(response.status(), 'synthetic TOTP password login succeeds').toBe(201);
            expect((await response.json()).mfaRequired === true, 'TOTP password login requires its second factor').toBe(true);
            await expect(page.getByRole('heading', { name: '2차 인증', exact: true })).toBeVisible();
            await page.getByLabel('2차 인증 코드', { exact: true }).fill(await authenticator.nextCode());
            await page.getByRole('button', { name: '확인', exact: true }).click();
            await expect(page.getByRole('button', { name: '게임 시작', exact: true })).toBeVisible();
        };
        await totpLogin(account.password); await logout(page);

        await page.goto('/reset-password');
        await page.getByLabel('이메일', { exact: true }).fill(account.email);
        const check = watchHumanCheck(page);
        await page.getByRole('button', { name: '코드 발송', exact: true }).click();
        await completeHumanChallenge(page, check);
        const emailCode = await resetMailCode(page, account.email);
        await page.getByLabel('인증 코드', { exact: true }).fill(emailCode);
        await page.getByLabel('새 비밀번호', { exact: true }).fill(recovered.password);
        await page.getByRole('button', { name: '새 비밀번호 설정', exact: true }).click();
        await expect(page.getByText('2차 인증 코드를 입력해 주세요.', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: '새 비밀번호 설정', exact: true })).toBeDisabled();
        await page.getByLabel('2차 인증 코드', { exact: true }).fill(await authenticator.nextCode());
        await page.getByRole('button', { name: '새 비밀번호 설정', exact: true }).click();
        await expect(page).toHaveURL(/\/login$/);
        await expect(page.getByText('비밀번호를 재설정했습니다. 새 비밀번호로 로그인해 주세요.', { exact: true })).toBeVisible();
        const [afterReset] = await db`select
            (select count(*)::int from sessions where user_id = ${account.id} and revoked_at is null) as active,
            (select count(*)::int from mfa_settings where user_id = ${account.id} and method = 'totp') as totp`;
        expect(afterReset, 'password recovery revokes all sessions while retaining TOTP protection').toMatchObject({ active: 0, totp: 1 });
        await totpLogin(recovered.password);

        await security(page);
        await expect(page.locator('.mfa-secret-card')).toHaveCount(0);
        await page.getByRole('button', { name: '2차 인증 끄기', exact: true }).click();
        const action = page.locator('.mfa-action-card');
        await action.getByLabel('2차 인증 코드', { exact: true }).fill(await authenticator.nextCode());
        await action.getByRole('button', { name: '확인', exact: true }).click();
        await expect(page.getByText('꺼짐', { exact: true })).toBeVisible();
        const [disabled] = await db`select count(*)::int as totp from mfa_settings where user_id = ${account.id}`;
        expect(disabled?.totp).toBe(0);
        expect(external, 'TOTP registration and recovery use no external authenticator or QR service').toEqual([]);
    } finally {
        await Promise.allSettled(observing);
        await testInfo.attach('public-recovery-http-state', { body: JSON.stringify(evidence), contentType: 'application/json' });
        await context.close(); await db.end();
    }
});
