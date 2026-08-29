import { expect, test } from '@playwright/test';
import { T, button, deleteAccount, logIn, signUpAndLogIn } from '../support/app';

test.describe('프로필 · 전적 · 로그인 기기', () => {
    test('전적 카드가 서버에서 온 값을 보여 준다', async ({ page }) => {
        const account = await signUpAndLogIn(page, 'stats');
        await page.goto('/profile');

        await expect(page.getByText(T.profile.statsKicker)).toBeVisible();
        // 갓 만든 계정이라 0판이지만, "불러오는 중"이나 "실패"에서 멈추면 안 된다.
        await expect(page.locator('.profile-stat-grid')).toBeVisible();
        await expect(page.getByText(T.profile.statsLoadFailed)).toHaveCount(0);
        await expect(page.getByText(T.profile.noMatches)).toBeVisible();

        await deleteAccount(page, account);
    });

    test('레벨은 1부터 시작하고 다음 레벨까지의 진행도를 함께 보여 준다', async ({ page }) => {
        const account = await signUpAndLogIn(page, 'level');
        await page.goto('/profile');
        await expect(page.locator('.profile-stat-grid')).toBeVisible();

        // 마지막 칸이 레벨이다. 0레벨이 나오면 곡선 계산이 깨진 것이다.
        const levelCell = page.locator('.profile-stat-grid > span').last();
        await expect(levelCell.locator('strong')).toHaveText('1');
        await expect(levelCell.locator('small')).toContainText('/');

        await deleteAccount(page, account);
    });

    test('다른 기기를 여기서 로그아웃시킬 수 있다', async ({ page, browser }) => {
        const account = await signUpAndLogIn(page, 'devices');

        const other = await browser.newContext();
        const otherPage = await other.newPage();
        await logIn(otherPage, account);

        await page.goto('/profile');
        await page.getByRole('button', { name: T.rooms.refresh }).last().click();
        // 두 기기가 목록에 보여야 한다. 하나만 보이면 세션이 안 쌓이고 있는 것이다.
        await expect(page.locator('.session-list article')).toHaveCount(2, { timeout: 20_000 });

        await button(page, T.profile.revokeOthers).click();
        await expect(page.locator('.session-list article')).toHaveCount(1);
        // "다른 기기 모두 로그아웃" 버튼도 같은 말을 담고 있다. 결과는 상태 영역에서 읽는다.
        await expect(page.locator('.session-panel footer [role="status"]')).toContainText('로그아웃');

        await other.close();
        await deleteAccount(page, account);
    });
});
