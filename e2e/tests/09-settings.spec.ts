import { expect, test } from '@playwright/test';
import en from '../../client/src/locales/en.json';
import { T, button, gotoHome } from '../support/app';

test.describe('설정 · 도움말', () => {
    test('테마를 바꾸면 문서 전체가 따라 바뀌고 새로고침해도 남는다', async ({ page }) => {
        await gotoHome(page);
        const before = await page.locator('html').getAttribute('data-theme');
        await page.getByRole('button', { name: T.common.toggleTheme }).click();
        await expect(page.locator('html')).not.toHaveAttribute('data-theme', before ?? 'light');

        await page.reload();
        // 설정이 안 남으면 사용자는 들어올 때마다 다시 바꿔야 한다.
        await expect(page.locator('html')).not.toHaveAttribute('data-theme', before ?? 'light');
    });

    test('언어를 바꾸면 화면 글자가 실제로 바뀐다', async ({ page }) => {
        await gotoHome(page);
        await page.goto('/settings');
        await page.getByRole('tab', { name: T.settings.tabs.general }).click();
        await page.getByRole('button', { name: 'English', exact: true }).click();

        await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: 10_000 });
        await page.goto('/');
        await expect(button(page, en.titlePage.button.gameStart)).toBeVisible();

        // 다음 점검이 한국어 문구로 화면을 찾으므로 되돌려 놓는다.
        await page.goto('/settings');
        await page.getByRole('button', { name: '한국어', exact: true }).click();
        await expect(page.locator('html')).toHaveAttribute('lang', 'ko', { timeout: 10_000 });
    });

    test('설정 탭 네 개가 모두 열린다', async ({ page }) => {
        await gotoHome(page);
        await page.goto('/settings');
        for (const name of Object.values(T.settings.tabs).filter((value) => value !== T.settings.tabs.label)) {
            await page.getByRole('tab', { name }).click();
            await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
        }
    });

    test('도움말의 스킬 설명이 실제 밸런스 수치로 나온다', async ({ page }) => {
        await gotoHome(page);
        await page.goto('/how-to-play');
        for (const skill of Object.values(T.lobby.skills)) {
            await expect(page.getByText(skill, { exact: true }).first()).toBeVisible();
        }
        // 손으로 찍은 그림이면 쿨타임 숫자가 사라져도 아무 티가 안 난다.
        await expect(page.locator('.guide-page')).toContainText('초');
    });
});
