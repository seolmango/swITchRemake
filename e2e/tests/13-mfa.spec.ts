import { expect, test, type Page } from '@playwright/test';
import { T, button, deleteAccount, logIn, newAccount, signUp } from '../support/app';
import { clearMail, waitForMail, waitForMailReissue, type SinkMail } from '../support/mail';

const openSecuritySettings = async (page: Page): Promise<void> => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: T.settings.tabs.security }).click();
    await expect(page.getByText(T.settings.security.status, { exact: true })).toBeVisible();
};

const enableEmailMfa = async (page: Page, password: string): Promise<string[]> => {
    await openSecuritySettings(page);
    const emailMethod = page.getByRole('radio').filter({ hasText: T.settings.security.method.email });
    await expect(emailMethod).toHaveAttribute('aria-checked', 'true');
    await page.getByLabel(T.auth.currentPassword, { exact: true }).fill(password);
    await button(page, T.settings.security.enable).click();

    const backupRegion = page.getByRole('region', { name: T.settings.security.saveBackupCodes });
    await expect(backupRegion).toBeVisible();
    await expect(backupRegion).toContainText(T.settings.security.backupCodesOnlyOnce);
    const codes = await backupRegion.locator('code').allTextContents();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);

    await backupRegion.getByRole('checkbox', { name: T.settings.security.codesSaved }).click();
    await backupRegion.getByRole('button', { name: T.common.done, exact: true }).click();
    await expect(page.getByText(T.settings.security.enabled, { exact: true })).toBeVisible();
    await expect(page.getByText('10', { exact: true })).toBeVisible();
    return codes;
};

const logOut = async (page: Page): Promise<void> => {
    await page.goto('/profile');
    await page.locator('.profile-actions').getByRole('button', { name: T.auth.logout }).click();
    await page.waitForURL((url) => new URL(url).pathname === '/');
};

const beginMfaLogin = async (page: Page, email: string, password: string): Promise<void> => {
    await page.goto('/login');
    await page.getByLabel(T.auth.email, { exact: true }).fill(email);
    await page.getByLabel(T.auth.password, { exact: true }).fill(password);
    await button(page, T.auth.login).click();
    await expect(page.getByRole('heading', { name: T.auth.mfaTitle })).toBeVisible();
    await expect(page.getByLabel(T.auth.secondFactorCode, { exact: true })).toBeVisible();
};

const finishMfaLogin = async (page: Page, code: string, trustDevice = false): Promise<void> => {
    await page.getByLabel(T.auth.secondFactorCode, { exact: true }).fill(code);
    if (trustDevice) {
        await page.getByRole('checkbox', { name: T.auth.trustDevice, exact: true }).click();
    }
    await button(page, T.auth.verify).click();
    await page.waitForURL((url) => new URL(url).pathname === '/');
};

const loginWithMfaMail = async (
    page: Page,
    email: string,
    password: string,
    trustDevice = false,
): Promise<SinkMail> => {
    await clearMail(email);
    await beginMfaLogin(page, email, password);
    await expect(page.getByText(T.auth.mfaEmailPrompt)).toBeVisible();
    const mail = await waitForMail(email, 'mfa');
    await finishMfaLogin(page, mail.code, trustDevice);
    // 같은 용도(mfa-login)의 코드는 60초에 한 번만 나간다. 한 흐름에서 두 번 로그인하려면
    // 그 창을 기다려야 하므로 언제 받았는지를 돌려준다.
    return mail;
};

const disableEmailMfa = async (page: Page, email: string): Promise<void> => {
    await openSecuritySettings(page);
    await button(page, T.settings.security.disable).click();
    const action = page.locator('.mfa-action-card');
    await expect(action.getByRole('heading', { name: T.settings.security.action.disable })).toBeVisible();

    // 화면과 서버 모두 코드 없는 쓰기를 허용하면 안 된다. 화면에서는 실행 버튼부터 잠긴다.
    const confirm = action.getByRole('button', { name: T.settings.security.confirm, exact: true });
    await expect(confirm).toBeDisabled();
    await clearMail(email);
    await action.getByRole('button', { name: T.settings.security.sendEmailCode, exact: true }).click();
    const mail = await waitForMail(email, 'mfa');
    await action.getByLabel(T.auth.secondFactorCode, { exact: true }).fill(mail.code);
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByText(T.settings.security.off, { exact: true })).toBeVisible();
};

test.describe('2차 인증', () => {
    test.describe.configure({ timeout: 180_000 });

    test('메일 방식은 로그인과 일회용 백업 코드를 검증하고 코드 없이는 끌 수 없다', async ({ page }) => {
        const account = newAccount('mfa-mail');
        await signUp(page, account);
        await logIn(page, account);
        const backupCodes = await enableEmailMfa(page, account.password);

        // 한 번만 보이는 화면을 닫은 뒤에는 기존 백업 코드 원문을 다시 꺼내지 못한다.
        await page.goto('/');
        await openSecuritySettings(page);
        await expect(page.locator('.mfa-backup-list')).toHaveCount(0);

        await logOut(page);
        await loginWithMfaMail(page, account.email, account.password);

        await logOut(page);
        await beginMfaLogin(page, account.email, account.password);
        await finishMfaLogin(page, backupCodes[0]!);

        await logOut(page);
        await beginMfaLogin(page, account.email, account.password);
        await page.getByLabel(T.auth.secondFactorCode, { exact: true }).fill(backupCodes[0]!);
        await button(page, T.auth.verify).click();
        await expect(page.getByText(T.auth.invalidSecondFactor)).toBeVisible();

        // 실패한 코드가 도전을 끝내지 않아야 다른 정상 백업 코드로 본인이 계속 들어갈 수 있다.
        await finishMfaLogin(page, backupCodes[1]!);
        await disableEmailMfa(page, account.email);
        await deleteAccount(page, account);
    });

    test('신뢰 기기는 다음 로그인을 건너뛰고 목록에서 2차 확인 뒤 해제된다', async ({ page }) => {
        const account = newAccount('mfa-trust');
        await signUp(page, account);
        await logIn(page, account);
        await enableEmailMfa(page, account.password);

        await logOut(page);
        const trustLoginMail = await loginWithMfaMail(page, account.email, account.password, true);
        await logOut(page);

        // 같은 브라우저의 신뢰 쿠키가 살아 있으므로 일반 로그인처럼 바로 들어간다.
        await logIn(page, account);
        await openSecuritySettings(page);
        const currentDevice = page.locator('.mfa-device-list article').filter({ hasText: T.settings.security.currentDevice });
        await expect(currentDevice).toHaveCount(1);
        await currentDevice.getByRole('button', { name: T.settings.security.revoke, exact: true }).click();

        const action = page.locator('.mfa-action-card');
        await expect(action.getByRole('heading', { name: T.settings.security.action.revoke })).toBeVisible();
        const confirm = action.getByRole('button', { name: T.settings.security.confirm, exact: true });
        await expect(confirm).toBeDisabled();
        await clearMail(account.email);
        await action.getByRole('button', { name: T.settings.security.sendEmailCode, exact: true }).click();
        const revokeMail = await waitForMail(account.email, 'mfa');
        await action.getByLabel(T.auth.secondFactorCode, { exact: true }).fill(revokeMail.code);
        await confirm.click();
        await expect(page.getByText(T.settings.security.noTrustedDevices)).toBeVisible();

        // 해제에 mfa-step-up 코드를 썼다. 아래 disableEmailMfa가 같은 용도를 또 쓰므로 창을 기다린다.
        await waitForMailReissue(revokeMail);

        await logOut(page);
        // 위에서 이미 mfa-login 코드를 한 번 받았다. 같은 용도라 60초 창이 지나야 다시 나온다.
        await waitForMailReissue(trustLoginMail);
        await clearMail(account.email);
        await beginMfaLogin(page, account.email, account.password);
        const loginMail = await waitForMail(account.email, 'mfa');
        await finishMfaLogin(page, loginMail.code);

        await disableEmailMfa(page, account.email);
        await deleteAccount(page, account);
    });

    test('비밀번호 재설정은 메일 인증만으로 끝나지 않고 2차 코드를 더 요구한다', async ({ page }) => {
        const account = newAccount('mfa-reset');
        await signUp(page, account);
        await logIn(page, account);
        await enableEmailMfa(page, account.password);
        await logOut(page);

        await clearMail(account.email);
        await page.goto('/reset-password');
        await page.getByLabel(T.auth.email, { exact: true }).fill(account.email);
        await button(page, T.auth.sendCode).click();
        const resetMail = await waitForMail(account.email, 'reset-password');
        const newPassword = 'MfaReset456!';
        await page.getByLabel(T.auth.code, { exact: true }).fill(resetMail.code);
        await page.getByLabel(T.auth.newPassword, { exact: true }).fill(newPassword);
        await button(page, T.auth.resetAction).click();

        await expect(page.getByText(T.auth.resetMfaRequired)).toBeVisible();
        const mfaMail = await waitForMail(account.email, 'mfa');
        await page.getByLabel(T.auth.secondFactorCode, { exact: true }).fill(mfaMail.code);
        await button(page, T.auth.resetAction).click();
        await page.waitForURL('**/login');
        await expect(page.getByText(T.auth.resetSuccess)).toBeVisible();

        const resetAccount = { ...account, password: newPassword };
        await loginWithMfaMail(page, resetAccount.email, resetAccount.password);
        await disableEmailMfa(page, resetAccount.email);
        await deleteAccount(page, resetAccount);
    });

    test('OTP 등록 응답의 비밀값과 setupToken은 등록 화면을 떠나면 다시 보이지 않는다', async ({ page }) => {
        const account = newAccount('mfa-totp');
        await signUp(page, account);
        await logIn(page, account);
        await openSecuritySettings(page);

        const totpMethod = page.getByRole('radio').filter({ hasText: T.settings.security.method.totp });
        await totpMethod.click();
        await expect(totpMethod).toHaveAttribute('aria-checked', 'true');
        await page.getByLabel(T.auth.currentPassword, { exact: true }).fill(account.password);
        const setupResponse = page.waitForResponse((response) =>
            response.request().method() === 'POST' && response.url().endsWith('/api/users/me/mfa/totp/setup'));
        await button(page, T.settings.security.setup).click();
        const response = await setupResponse;
        expect(response.ok()).toBeTruthy();
        const setup = await response.json() as { setupToken: string; secret: string; otpauthUri: string };
        expect(setup.setupToken).not.toBe('');
        expect(setup.secret).not.toBe('');
        expect(setup.otpauthUri).toContain('otpauth://totp/');

        const secretCard = page.locator('.mfa-secret-card');
        await expect(secretCard).toContainText(T.settings.security.secretOnlyOnce);
        await expect(secretCard.locator('code')).toHaveText(setup.secret);

        await page.goto('/');
        await openSecuritySettings(page);
        await expect(page.locator('.mfa-secret-card')).toHaveCount(0);
        await expect(page.getByText(T.settings.security.off, { exact: true })).toBeVisible();
        await deleteAccount(page, account);
    });
});
