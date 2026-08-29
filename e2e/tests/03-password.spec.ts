import { expect, test } from '@playwright/test';
import { T, button, deleteAccount, logIn, newAccount, signUp } from '../support/app';
import { clearMail, waitForMail } from '../support/mail';

test.describe('비밀번호 찾기와 변경', () => {
    test('비밀번호를 잊어도 메일 코드로 되찾는다', async ({ page }) => {
        const account = newAccount('reset');
        await signUp(page, account);

        await clearMail(account.email);
        await page.goto('/reset-password');
        await page.getByLabel(T.auth.email, { exact: true }).fill(account.email);
        await button(page, T.auth.sendCode).click();
        await expect(page.getByText(T.auth.codeSent)).toBeVisible();

        const mail = await waitForMail(account.email, 'reset-password');
        const newPassword = 'ResetPass456!';
        await page.getByLabel(T.auth.code, { exact: true }).fill(mail.code);
        await page.getByLabel(T.auth.newPassword, { exact: true }).fill(newPassword);
        await button(page, T.auth.resetAction).click();

        await page.waitForURL('**/login');
        await expect(page.getByText(T.auth.resetSuccess)).toBeVisible();

        // 옛 비밀번호는 더 이상 안 된다.
        await page.getByLabel(T.auth.email, { exact: true }).fill(account.email);
        await page.getByLabel(T.auth.password, { exact: true }).fill(account.password);
        await button(page, T.auth.login).click();
        await expect(page.getByText(T.auth.invalidCredentials)).toBeVisible();

        const reset = { ...account, password: newPassword };
        await logIn(page, reset);
        await deleteAccount(page, reset);
    });

    test('틀린 코드로는 남의 비밀번호를 바꿀 수 없다', async ({ page }) => {
        const account = newAccount('badcode');
        await signUp(page, account);

        await clearMail(account.email);
        await page.goto('/reset-password');
        await page.getByLabel(T.auth.email, { exact: true }).fill(account.email);
        await button(page, T.auth.sendCode).click();
        await waitForMail(account.email, 'reset-password');

        await page.getByLabel(T.auth.code, { exact: true }).fill('000000');
        await page.getByLabel(T.auth.newPassword, { exact: true }).fill('Attacker999!');
        await button(page, T.auth.resetAction).click();
        await expect(page.getByText(T.auth.invalidCodeServer)).toBeVisible();

        // 원래 비밀번호가 그대로여야 한다.
        await logIn(page, account);
        await deleteAccount(page, account);
    });

    test('로그인한 채로 비밀번호를 바꾸면 다른 기기가 끊긴다', async ({ page, browser }) => {
        const account = newAccount('change');
        await signUp(page, account);
        await logIn(page, account);

        // 다른 기기 하나를 더 만들어 둔다. 바꾼 뒤 이쪽이 끊겨야 한다.
        const other = await browser.newContext();
        const otherPage = await other.newPage();
        await logIn(otherPage, account);

        const newPassword = 'ChangedPass77!';
        await page.goto('/change-password');
        await page.getByLabel(T.auth.currentPassword, { exact: true }).fill(account.password);
        await page.getByLabel(T.auth.newPassword, { exact: true }).fill(newPassword);
        await page.getByLabel(T.auth.confirmNewPassword, { exact: true }).fill(newPassword);
        await button(page, T.auth.changeTitle).click();
        await expect(page.getByText(/다른 기기/)).toBeVisible();

        await other.close();
        const changed = { ...account, password: newPassword };
        await logIn(page, changed);
        await deleteAccount(page, changed);
    });
});
