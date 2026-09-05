import { expect, test } from '@playwright/test';
import { T, button, gotoHome, logIn, newAccount, signUp } from '../support/app';
import { clearMail, waitForMail } from '../support/mail';

test.describe('탈퇴', () => {
    test('탈퇴하면 계정과 로그인 기기가 사라지고 같은 이메일로 다시 가입할 수 있다', async ({ page, browser }) => {
        const account = newAccount('bye');
        await signUp(page, account);
        await logIn(page, account);

        // 다른 기기 하나. 탈퇴 뒤에 이쪽도 못 들어가야 한다.
        const other = await browser.newContext();
        const otherPage = await other.newPage();
        await logIn(otherPage, account);

        await clearMail(account.email);
        await page.goto('/profile');
        await button(page, T.profile.deleteTitle).click();
        await page.getByRole('button', { name: T.profile.deleteSendCode }).click();
        await expect(page.getByText(T.profile.deleteCodeSent)).toBeVisible();

        // 틀린 코드로는 지워지지 않는다.
        await page.locator('.delete-code-field input').fill('000000');
        await page.getByRole('button', { name: T.profile.deleteConfirm }).click();
        await expect(page.getByText(T.auth.invalidCodeServer)).toBeVisible();

        const mail = await waitForMail(account.email, 'delete');
        await page.locator('.delete-code-field input').fill(mail.code);
        await page.getByRole('button', { name: T.profile.deleteConfirm }).click();
        await page.waitForURL((url) => new URL(url).pathname === '/', { timeout: 30_000 });

        // 지워진 계정으로는 로그인이 안 된다.
        await page.goto('/login');
        await page.getByLabel(T.auth.email, { exact: true }).fill(account.email);
        await page.getByLabel(T.auth.password, { exact: true }).fill(account.password);
        await button(page, T.auth.login).click();
        await expect(page.getByText(T.auth.invalidCredentials)).toBeVisible();

        // 다른 기기의 세션도 같이 끊겼어야 한다.
        const stale = await otherPage.request.post('/api/auth/refresh');
        expect(stale.ok(), '탈퇴한 계정의 세션 갱신은 실패해야 한다').toBeFalsy();
        await other.close();

        // 게스트로는 여전히 놀 수 있어야 한다 — 탈퇴가 브라우저를 못 쓰게 만들면 안 된다.
        await gotoHome(page);
        await page.goto('/rooms');
        await expect(button(page, T.rooms.create)).toBeVisible();

        // 탈퇴는 상태 표시가 아니라 실제 삭제다. 이메일과 닉네임의 유일성도 함께 풀려야 한다.
        await signUp(page, account);
        await expect(page.getByText(T.auth.signupSuccess)).toBeVisible();
        await logIn(page, account);

        await clearMail(account.email);
        await page.goto('/profile');
        await button(page, T.profile.deleteTitle).click();
        await page.getByRole('button', { name: T.profile.deleteSendCode }).click();
        const cleanupMail = await waitForMail(account.email, 'delete');
        await page.locator('.delete-code-field input').fill(cleanupMail.code);
        await page.getByRole('button', { name: T.profile.deleteConfirm }).click();
        await page.waitForURL((url) => new URL(url).pathname === '/', { timeout: 30_000 });
    });
});
