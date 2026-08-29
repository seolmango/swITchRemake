import { expect, test } from '@playwright/test';
import { T, button, gotoHome } from '../support/app';

test.describe('훈련장', () => {
    test.describe.configure({ timeout: 150_000 });

    test('게스트도 혼자 들어가 움직이고 나올 수 있다', async ({ page }) => {
        await gotoHome(page);
        await button(page, T.titlePage.button.gameGuide).click();
        await page.waitForURL('**/how-to-play');
        await button(page, T.guide.training.button).click();
        await page.waitForURL('**/training');

        // 혼자 시작한다 — 다른 사람을 기다리면 안 된다.
        await expect(page.locator('.game-hud[data-hud-ready="true"]')).toBeVisible({ timeout: 90_000 });
        await expect(page.getByText(T.training.guide)).toBeVisible();

        await page.keyboard.down('d');
        await page.waitForTimeout(600);
        await page.keyboard.up('d');
        await expect(page.getByText(T.game.connectionLost)).toHaveCount(0);

        await button(page, T.training.exit).click();
        await page.waitForURL('**/how-to-play', { timeout: 30_000 });
    });

    test('훈련장은 방 목록에 뜨지 않는다', async ({ page, browser }) => {
        await gotoHome(page);
        await page.goto('/training');
        await expect(page.locator('.game-hud[data-hud-ready="true"]')).toBeVisible({ timeout: 90_000 });

        const other = await browser.newContext();
        const otherPage = await other.newPage();
        await gotoHome(otherPage);
        await otherPage.goto('/rooms');
        // 훈련장이 목록에 뜨면 남이 들어오려다 실패한다.
        await expect(otherPage.getByText(T.training.roomName)).toHaveCount(0);
        await other.close();

        await button(page, T.training.exit).click();
    });
});
