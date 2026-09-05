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

    test('설정 탭 다섯 개가 모두 열린다', async ({ page }) => {
        await gotoHome(page);
        await page.goto('/settings');
        for (const name of Object.values(T.settings.tabs).filter((value) => value !== T.settings.tabs.label)) {
            await page.getByRole('tab', { name }).click();
            await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
        }
    });

    test('개인정보처리방침은 실제 운영 내용을 보여 준다', async ({ page }) => {
        await gotoHome(page);
        await page.goto('/settings');

        await page.getByRole('button').filter({ hasText: T.settings.general.privacy }).click();
        const privacy = page.getByRole('dialog', { name: T.legal.privacyPolicy });
        await expect(privacy).toContainText('0-INF');
        await expect(privacy).toContainText('zero2inf.zip@gmail.com');
        await expect(privacy).not.toContainText('작성자 메모');
        await expect(privacy).not.toContainText('확인 필요');

        /*
         * 「」는 아직 정하지 못한 자리다. 지금은 시행일과 호스팅 업체명 둘이 남아 있고,
         * 출시하면서 채운다(§15.1). **그때까지 이 점검은 실패하는 것이 정상이다.**
         * 빈칸이 화면에 그대로 보이는 것은 실제로 잘못된 상태라 통과시키지 않는다.
         * 실패 문구에 이유를 적어 둔다 — 진짜 회귀와 헷갈리지 않게 하려는 것이다.
         */
        await expect(
            privacy,
            '아직 못 채운 「」 빈칸이 남아 있다. 출시 전까지는 이 실패가 정상이다(§15.1: 시행일·호스팅 업체명)',
        ).not.toContainText('「');
    });

    test('크레딧은 실제 운영 내용을 보여 준다', async ({ page }) => {
        await gotoHome(page);
        await page.goto('/settings');

        await page.getByRole('button').filter({ hasText: T.settings.general.credits }).click();
        const credits = page.getByRole('dialog', { name: T.legal.credits });
        await expect(credits).toContainText(T.legal.operator);
        await expect(credits).toContainText('0-INF');
        await expect(credits).toContainText('zero2inf.zip@gmail.com');
        await expect(credits).not.toContainText('준비 중');
    });

    test('색각 보조를 켜면 의미 색상 팔레트 자체가 바뀐다', async ({ page }) => {
        await gotoHome(page);
        await page.goto('/settings');
        await page.getByRole('tab', { name: T.settings.tabs.game }).click();

        const semanticGood = () => page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--semantic-good').trim());
        const before = await semanticGood();
        expect(before).not.toBe('');

        await page.getByRole('button', { name: T.settings.game.deuteranopia, exact: true }).click();
        await expect(page.locator('html')).toHaveAttribute('data-color-vision', 'deuteranopia');
        const after = await semanticGood();
        expect(after).not.toBe(before);
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
