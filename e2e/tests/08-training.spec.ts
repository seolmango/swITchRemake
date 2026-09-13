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
        await expect(page.getByRole('img', { name: T.training.minimapLabel })).toBeVisible();
        await expect(page.locator('.training-role')).toBeVisible();
        await expect(page.locator('.training-role')).toHaveAttribute('data-role', /^(runner|tagger)$/);
        await expect(page.getByText(T.game.hud.controls.title, { exact: true })).toHaveCount(0);
        await expect(page.locator('.game-hud').getByText(T.game.hud.alive, { exact: true })).toHaveCount(0);
        const minimap = page.locator('.training-minimap');
        const initialMap = await minimap.boundingBox();
        expect(initialMap).not.toBeNull();
        await button(page, T.training.enlargeMap).click();
        const enlargedMap = await minimap.boundingBox();
        expect(enlargedMap!.width).toBeGreaterThan(initialMap!.width);
        await button(page, T.training.shrinkMap).click();
        expect((await minimap.boundingBox())!.width).toBeCloseTo(initialMap!.width, 0);
        const skillButtons = page.locator('.game-hud button[title]').filter({ has: page.locator('img') });
        await expect(skillButtons.first()).toBeVisible();
        const toolbar = await page.locator('.training-hud-toolbar').boundingBox();
        expect(toolbar).not.toBeNull();
        for (const skill of await skillButtons.all()) {
            const box = await skill.boundingBox();
            expect(box).not.toBeNull();
            expect(toolbar!.y + toolbar!.height).toBeLessThanOrEqual(box!.y);
        }
        await button(page, T.training.settings).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await button(page, T.training.closeSettings).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);

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

    test('게스트 로그인 입력은 누르는 동안만 비밀번호를 보여 준다', async ({ page }) => {
        await gotoHome(page);
        await page.goto('/login');
        const password = page.getByLabel(T.auth.password, { exact: true });
        await password.fill('DisplayOnly123!');
        const reveal = button(page, T.auth.holdToRevealPassword);
        await expect(password).toHaveAttribute('type', 'password');
        await reveal.hover();
        await page.mouse.down();
        await expect(password).toHaveAttribute('type', 'text');
        await page.mouse.move(10, 10);
        await page.mouse.up();
        await expect(password).toHaveAttribute('type', 'password');
        await reveal.focus();
        await page.keyboard.down('Space');
        await expect(password).toHaveAttribute('type', 'text');
        await page.keyboard.up('Space');
        await expect(password).toHaveAttribute('type', 'password');
        await expect(password).toHaveValue('DisplayOnly123!');
    });
});
