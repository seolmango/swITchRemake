import { expect, test } from '@playwright/test';
import { T, button, deleteAccount, logIn, newAccount, signUp } from '../support/app';

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

    test('같은 이메일로 두 번 가입할 수 없다', async ({ page }) => {
        const account = newAccount('dup');
        await signUp(page, account);
        await logIn(page, account);

        // 두 번째 가입은 코드까지 받아 놓고 마지막에 막혀야 한다.
        const duplicate = { ...account, nickname: `${account.nickname}2`.slice(0, 12) };
        await page.goto('/signup');
        await page.getByLabel(T.auth.email).fill(duplicate.email);
        await button(page, T.auth.sendCode).click();
        await expect(page.getByText(T.auth.codeSent)).toBeVisible();

        await page.getByLabel(T.auth.nickname).fill(duplicate.nickname);
        await page.getByLabel(T.auth.code).fill('000000');
        await page.getByLabel(T.auth.password).fill(duplicate.password);
        await button(page, T.auth.signup).click();
        await expect(page.getByText(T.auth.invalidCodeServer)).toBeVisible();

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
