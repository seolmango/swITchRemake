import { expect, test } from '@playwright/test';
import { T, button, gotoHome } from '../support/app';

test.describe('첫 방문과 게스트', () => {
    test('처음 온 사람은 아무것도 하지 않아도 게스트로 들어온다', async ({ page }) => {
        await gotoHome(page);
        // 게스트 신원이 발급되지 않으면 방 목록이 401로 막힌다. 여기까지 오면 발급된 것이다.
        await button(page, T.titlePage.button.gameStart).click();
        await page.waitForURL('**/rooms');
        await expect(button(page, T.rooms.create)).toBeVisible();
    });

    test('서버 상태 표시가 실제 상태를 읽는다', async ({ page }) => {
        await gotoHome(page);
        const status = page.locator('.server-status');
        await expect(status).toBeVisible();
        // "연결 중"에서 멈춰 있으면 헬스 체크가 죽은 것이다.
        await expect(status).not.toContainText(T.serverStatus.checking, { timeout: 20_000 });

        // 점검 API가 아직 없는 동안에도 서버 단절을 정체불명의 오류로 뭉개면 안 된다.
        await page.route('**/api/health', (route) => route.abort('connectionrefused'));
        await page.reload();
        await expect(page.getByRole('heading', { name: T.serviceStatus.offlineTitle })).toBeVisible();
        await expect(page.getByText(T.serviceStatus.offlineBody)).toBeVisible();
        await expect(button(page, T.serviceStatus.retry)).toBeVisible();
    });

    test('지원하지 않는 브라우저는 앱 대신 지원 안내를 보여 준다', async ({ page }) => {
        await page.addInitScript(() => {
            Object.defineProperty(globalThis, 'DecompressionStream', {
                configurable: true,
                value: undefined,
            });
        });
        await page.goto('/');

        await expect(page.getByRole('heading', { name: T.browserUnsupported.title })).toBeVisible();
        await expect(page.getByText(T.browserUnsupported.body)).toBeVisible();
        await expect(button(page, T.titlePage.button.gameStart)).toHaveCount(0);
    });

    test('없는 주소는 404 화면으로 간다', async ({ page }) => {
        await page.goto('/이런페이지는없다');
        await expect(page.getByText(T.notFound.title)).toBeVisible();
    });

    test('게스트 프로필은 전적이 없다고 분명히 말한다', async ({ page }) => {
        await gotoHome(page);
        await page.goto('/profile');
        await expect(page.getByText(T.profile.guestStats)).toBeVisible();
        await expect(button(page, T.auth.login)).toBeVisible();
    });

    test('도움말은 규칙·조작·스킬을 다 보여 준다', async ({ page }) => {
        await gotoHome(page);
        await button(page, T.titlePage.button.gameGuide).click();
        await page.waitForURL('**/how-to-play');
        await expect(page.locator('.guide-shell, .page-screen')).toBeVisible();
    });
});
