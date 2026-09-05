import { expect, test } from '@playwright/test';
import { T, button, deleteAccount, logIn, newAccount, signUp } from '../support/app';
import { clearMail, waitForMail } from '../support/mail';

test.describe('가입 · 로그인 · 로그아웃', () => {
    test('가입하고 로그인하고 로그아웃한다', async ({ page }) => {
        const account = newAccount('acct');
        await signUp(page, account);
        // 가입을 마치고 넘어온 안내가 로그인 화면에 실제로 보여야 한다.
        await expect(page.getByText(T.auth.signupSuccess)).toBeVisible();

        await logIn(page, account);
        await page.goto('/profile');
        await expect(page.getByRole('heading', { name: account.nickname })).toBeVisible();

        await page.locator('.profile-actions').getByRole('button', { name: T.auth.logout }).click();
        await page.waitForURL((url) => new URL(url).pathname === '/');
        // 로그아웃하면 게스트로 내려온다 — 아무것도 못 하는 상태가 되면 안 된다.
        await page.goto('/profile');
        await expect(page.getByText(T.profile.guestStats)).toBeVisible();

        await logIn(page, account);
        await deleteAccount(page, account);
    });

    test('약관과 처리방침에 모두 동의해야 가입할 수 있고 원문을 읽을 수 있다', async ({ page }) => {
        const account = newAccount('agree');
        await clearMail(account.email);
        await page.goto('/signup');
        await page.getByLabel(T.auth.email, { exact: true }).fill(account.email);
        await button(page, T.auth.sendCode).click();
        const mail = await waitForMail(account.email, 'signup');
        await page.getByLabel(T.auth.nickname, { exact: true }).fill(account.nickname);
        await page.getByLabel(T.auth.code, { exact: true }).fill(mail.code);
        await page.getByLabel(T.auth.password, { exact: true }).fill(account.password);

        const signup = button(page, T.auth.signup);
        await expect(signup).toBeDisabled();

        const readButtons = page.getByRole('button', { name: T.auth.readDocument, exact: true });
        await expect(readButtons).toHaveCount(2);
        await readButtons.nth(0).click();
        const terms = page.getByRole('dialog', { name: T.legal.termsOfService });
        await expect(terms).toContainText('제1조 (목적)');
        await expect(terms).toContainText('zero2inf.zip@gmail.com');
        await button(page, T.legal.close).click();

        await readButtons.nth(1).click();
        const privacy = page.getByRole('dialog', { name: T.legal.privacyPolicy });
        await expect(privacy).toContainText('무엇을 모으고, 왜 모으는가');
        await expect(privacy).toContainText('zero2inf.zip@gmail.com');
        await button(page, T.legal.close).click();

        await page.getByRole('checkbox', { name: T.auth.agreeTerms, exact: true }).click();
        await expect(signup).toBeDisabled();
        await page.getByRole('checkbox', { name: T.auth.agreePrivacy, exact: true }).click();
        await expect(signup).toBeEnabled();
        await signup.click();
        await page.waitForURL('**/login');

        await logIn(page, account);
        await deleteAccount(page, account);
    });

    test('같은 이메일로 두 번 가입할 수 없다', async ({ page }) => {
        const account = newAccount('dup');
        await signUp(page, account);
        const firstSignupMail = await waitForMail(account.email, 'signup');
        await logIn(page, account);

        // 두 번째 가입은 올바른 코드와 동의를 모두 갖춰도 마지막에 같은 문구로 막혀야 한다.
        // 같은 용도의 메일은 60초에 한 번만 발급되므로 첫 가입 메일의 제한이 끝난 뒤 다시 받는다.
        const mailAvailableAt = new Date(firstSignupMail.sentAt).getTime() + 60_000;
        await page.waitForTimeout(Math.max(0, mailAvailableAt - Date.now() + 250));
        const duplicate = { ...account, nickname: `${account.nickname}2`.slice(0, 12) };
        await clearMail(duplicate.email);
        await page.goto('/signup');
        await page.getByLabel(T.auth.email).fill(duplicate.email);
        await button(page, T.auth.sendCode).click();
        await expect(page.getByText(T.auth.codeSent)).toBeVisible();
        const mail = await waitForMail(duplicate.email, 'signup');

        await page.getByLabel(T.auth.nickname).fill(duplicate.nickname);
        await page.getByLabel(T.auth.code).fill(mail.code);
        await page.getByLabel(T.auth.password).fill(duplicate.password);
        await page.getByRole('checkbox', { name: T.auth.agreeTerms, exact: true }).click();
        await page.getByRole('checkbox', { name: T.auth.agreePrivacy, exact: true }).click();
        await button(page, T.auth.signup).click();
        await expect(page.getByText(T.auth.duplicateAccount)).toBeVisible();

        await logIn(page, account);
        await deleteAccount(page, account);
    });

    test('틀린 비밀번호는 무엇이 틀렸는지 알려 주지 않는다', async ({ page }) => {
        const account = newAccount('wrong');
        await signUp(page, account);

        await page.goto('/login');
        await page.getByLabel(T.auth.email).fill(account.email);
        await page.getByLabel(T.auth.password).fill('WrongPass123!');
        await button(page, T.auth.login).click();
        // 이메일이 있는지 없는지를 응답으로 구분할 수 있으면 계정 조회기가 된다.
        await expect(page.getByText(T.auth.invalidCredentials)).toBeVisible();

        await logIn(page, account);
        await deleteAccount(page, account);
    });

    test('탈퇴한 계정으로는 다시 로그인할 수 없다', async ({ page }) => {
        const account = newAccount('gone');
        await signUp(page, account);
        await logIn(page, account);
        await deleteAccount(page, account);

        await page.goto('/login');
        await page.getByLabel(T.auth.email).fill(account.email);
        await page.getByLabel(T.auth.password).fill(account.password);
        await button(page, T.auth.login).click();
        await expect(page.getByText(T.auth.invalidCredentials)).toBeVisible();
    });
});
