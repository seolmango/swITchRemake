import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { database, isolatedContext, login, seedAccount } from './helpers';

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
async function localMail(page: Page, email: string, subject: string, excluded: ReadonlySet<string> = new Set()) {
    let id: string | undefined;
    await expect.poll(async () => {
        const response = await page.request.get(`http://mailpit:8025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
        if (!response.ok()) return false;
        const data = await response.json();
        id = data.messages?.find((message: { Subject?: string; ID: string }) =>
            message.Subject?.includes(subject) && !excluded.has(message.ID))?.ID;
        return Boolean(id);
    }, { timeout: 15_000, message: 'fresh synthetic security mail arrives over local SMTP' }).toBe(true);
    const response = await page.request.get(`http://mailpit:8025/api/v1/message/${id}`);
    expect(response.ok(), 'local security mail is readable').toBe(true);
    const data = await response.json();
    const code = `${data.Text ?? ''}\n${data.HTML ?? ''}`.match(/\b\d{6}\b/)?.[0];
    expect(Boolean(code), 'synthetic security mail contains a verification code').toBe(true);
    return { id: id!, code: code! };
}
async function accountCounts(userId: number) {
    const db = database();
    try {
        const [row] = await db`select
            (select count(*)::int from sessions where user_id = ${userId} and revoked_at is null and expires_at > now()) as sessions,
            (select count(*)::int from mfa_settings where user_id = ${userId} and method = 'email') as email_mfa,
            (select count(*)::int from trusted_devices where user_id = ${userId}) as trusted,
            (select count(*)::int from mfa_backup_codes where user_id = ${userId} and used_at is not null) as used_backup`;
        return row;
    } finally { await db.end(); }
}

test('extended account succeeds through password, email MFA, trusted device, session revocation and deletion', async ({ browser }) => {
    test.setTimeout(420_000);
    // Shared endpoint limits remain unchanged. Begin in a fresh one-minute login window,
    // then wait again before the sixth login. This is pacing, not an identity/rate bypass.
    await new Promise<void>(done => setTimeout(done, 61_000));
    const account = await seedAccount();
    const changed = { ...account, password: `Pw${randomBytes(6).toString('hex')}!` };
    const primary = await isolatedContext(browser);
    const other = await isolatedContext(browser);
    try {
        const page = await primary.context.newPage();
        const otherPage = await other.context.newPage();
        await login(page, account); await login(otherPage, account);
        expect((await accountCounts(account.id))?.sessions, 'two successful UI logins create two active sessions').toBe(2);

        await page.goto('/change-password');
        await page.getByLabel('현재 비밀번호', { exact: true }).fill(account.password);
        await page.getByLabel('새 비밀번호', { exact: true }).fill(changed.password);
        await page.getByLabel('새 비밀번호 확인', { exact: true }).fill(changed.password);
        await page.getByRole('button', { name: '비밀번호 변경', exact: true }).click();
        await expect(page.getByText('비밀번호를 변경했습니다. 다른 기기 1대를 로그아웃했습니다.', { exact: true })).toBeVisible();
        expect((await accountCounts(account.id))?.sessions, 'password change leaves only the initiating session').toBe(1);
        const staleAfterChange = await other.context.request.post('/api/auth/refresh');
        expect(staleAfterChange.status(), 'other device cannot refresh after password change').toBe(401);
        await logout(page); await login(page, changed);

        await security(page);
        await page.getByLabel('현재 비밀번호', { exact: true }).fill(changed.password);
        await page.getByRole('button', { name: '메일 인증 켜기', exact: true }).click();
        const backup = page.getByRole('region', { name: '백업 코드를 저장하세요', exact: true });
        await expect(backup).toBeVisible();
        const codes = await backup.locator('code').allTextContents();
        expect(codes.length, 'ten backup codes appear once').toBe(10);
        expect(new Set(codes).size, 'issued backup codes are distinct').toBe(10);
        const done = backup.getByRole('button', { name: '완료', exact: true });
        await expect(done).toBeDisabled();
        await backup.getByRole('checkbox', { name: '안전한 곳에 저장했습니다', exact: true }).click(); await done.click();
        await expect(page.getByText('켜짐', { exact: true })).toBeVisible();
        expect((await accountCounts(account.id))?.email_mfa).toBe(1);
        await logout(page);

        await page.goto('/login');
        await page.getByLabel('이메일', { exact: true }).fill(account.email);
        await page.getByLabel('비밀번호', { exact: true }).fill(changed.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click();
        await expect(page.getByRole('heading', { name: '2차 인증', exact: true })).toBeVisible();
        const loginMail = await localMail(page, account.email, '2차 인증 코드');
        await page.getByLabel('2차 인증 코드', { exact: true }).fill(loginMail.code);
        await page.getByRole('checkbox', { name: '이 기기를 신뢰 기기로 등록', exact: true }).click();
        await page.getByRole('button', { name: '확인', exact: true }).click();
        await expect(page.getByRole('button', { name: '게임 시작', exact: true })).toBeVisible();
        expect((await accountCounts(account.id))?.trusted).toBe(1);
        await logout(page); await login(page, changed); // fifth login uses the trusted browser
        await expect(page.getByRole('heading', { name: '2차 인증', exact: true })).toHaveCount(0);

        await security(page);
        const trusted = page.locator('.mfa-device-list article').filter({ hasText: '현재 기기' });
        await expect(trusted).toHaveCount(1);
        await trusted.getByRole('button', { name: '해제', exact: true }).click();
        let action = page.locator('.mfa-action-card');
        await action.getByLabel('2차 인증 코드', { exact: true }).fill(codes[0]!);
        await action.getByRole('button', { name: '확인', exact: true }).click();
        await expect(page.getByText('등록된 신뢰 기기가 없습니다.', { exact: true })).toBeVisible();
        expect(await accountCounts(account.id)).toMatchObject({ trusted: 0, used_backup: 1 });

        await page.getByRole('button', { name: '2차 인증 끄기', exact: true }).click();
        action = page.locator('.mfa-action-card');
        await expect(action.getByRole('button', { name: '확인', exact: true })).toBeDisabled();
        await action.getByRole('button', { name: '메일 코드 받기', exact: true }).click();
        const stepUp = await localMail(page, account.email, '2차 인증 코드', new Set([loginMail.id]));
        await action.getByLabel('2차 인증 코드', { exact: true }).fill(stepUp.code);
        await action.getByRole('button', { name: '확인', exact: true }).click();
        await expect(page.getByText('꺼짐', { exact: true })).toBeVisible();
        expect((await accountCounts(account.id))?.email_mfa).toBe(0);

        await new Promise<void>(done => setTimeout(done, 61_000));
        await login(otherPage, changed);
        await page.goto('/profile');
        await page.getByRole('button', { name: '기기 관리', exact: true }).click();
        const devices = page.getByRole('dialog', { name: '로그인한 기기', exact: true });
        await expect(devices.locator('.session-list article')).toHaveCount(2);
        await devices.getByRole('button', { name: '다른 기기 모두 로그아웃', exact: true }).click();
        await expect(devices.locator('.session-list article')).toHaveCount(1);
        expect((await accountCounts(account.id))?.sessions).toBe(1);
        await expect.poll(() => devices.evaluate(element => element.contains(document.activeElement)), {
            message: 'completed device revocation keeps focus inside its modal',
        }).toBe(true);
        const staleAfterRevoke = await other.context.request.post('/api/auth/refresh');
        expect(staleAfterRevoke.status(), 'revoked device cannot refresh').toBe(401);
        await page.keyboard.press('Escape'); await expect(devices).toHaveCount(0);

        await page.getByRole('button', { name: '회원 탈퇴', exact: true }).click();
        const deletion = page.getByRole('alertdialog', { name: '회원 탈퇴', exact: true });
        const deleteCodeResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/users/me/delete-code');
        await deletion.getByRole('button', { name: '인증 코드 받기', exact: true }).click();
        expect((await deleteCodeResponse).status(), 'synthetic account deletion sends its verification mail').toBe(201);
        const deleteMail = await localMail(page, account.email, '회원 탈퇴 인증 코드');
        await expect(deletion.getByRole('button', { name: '탈퇴하기', exact: true })).toBeDisabled();
        await deletion.getByLabel('인증 코드', { exact: true }).fill(deleteMail.code);
        const deletedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/users/me' && response.request().method() === 'DELETE');
        await deletion.getByRole('button', { name: '탈퇴하기', exact: true }).click();
        const deleted = await deletedResponse;
        expect(deleted.status(), 'verified synthetic deletion succeeds').toBe(200);
        expect((await deleted.json()).deleted === true).toBe(true);
        await expect(page).toHaveURL('http://web/');
        const db = database();
        try {
            const [row] = await db`select account_status = 'DELETED' as deleted,
                email <> ${account.email} as email_anonymized, nickname <> ${account.nickname} as nickname_anonymized
                from users where id = ${account.id}`;
            expect(row, 'deleted synthetic account is anonymized in persistent storage').toMatchObject({ deleted: true, email_anonymized: true, nickname_anonymized: true });
        } finally { await db.end(); }
        expect(await accountCounts(account.id)).toMatchObject({ sessions: 0, email_mfa: 0, trusted: 0 });
        await page.goto('/profile');
        await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeVisible();
        expect([...primary.external, ...other.external], 'all browser traffic stays in the internal disposable app').toEqual([]);
    } finally { await primary.context.close(); await other.context.close(); }
});
