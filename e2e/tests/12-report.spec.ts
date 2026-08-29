import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { T, createRoom, deleteAccount, gotoHome, joinRoom, seatedPlayers, signUpAndLogIn, startMatch } from '../support/app';

/** 경기가 끝나기를 기다린다. 07-match와 같은 이유로 넉넉히 잡는다. */
const MATCH_TIMEOUT_MS = 5 * 60_000;

function grantAdmin(email: string, revoke = false): void {
    execFileSync(
        process.execPath,
        [resolve(__dirname, '..', '..', 'scripts', 'grant-admin.cjs'), email, ...(revoke ? ['--revoke'] : [])],
        { cwd: resolve(__dirname, '..', '..'), stdio: 'pipe' },
    );
}

async function guestInRoom(context: BrowserContext, code: string): Promise<Page> {
    const page = await context.newPage();
    await gotoHome(page);
    await joinRoom(page, code);
    return page;
}

/**
 * 결과 화면까지 간다.
 *
 * 방장만 계정이고 나머지 둘은 게스트다 — 신고는 계정만 할 수 있으므로 신고하는 쪽이 방장이고,
 * 신고당하는 쪽은 게스트가 된다. **제재를 걸 수 없는 사건**이 만들어지는 셈이라, 그 화면이
 * 이유를 제대로 말하는지까지 여기서 확인된다.
 */
async function playedMatch(page: Page, context: BrowserContext, tag: string) {
    const code = await createRoom(page, `E2E-${tag}-${Date.now().toString(36)}`);
    const guests = [await guestInRoom(context, code), await guestInRoom(context, code)] as const;
    await expect(seatedPlayers(page)).toHaveCount(3, { timeout: 30_000 });

    await startMatch(page);
    await page.waitForURL('**/game**', { timeout: 60_000 });
    for (const guest of guests) await guest.waitForURL('**/game**', { timeout: 60_000 });

    /*
     * 한 명을 내보내 경기를 끝낸다. 셋이 가만히 서 있으면 자기장이 줄어 누군가 탈락할 때까지
     * 몇 분이 걸리는데, 이 점검이 보려는 것은 경기가 아니라 **결과 화면의 신고**다. 남은 둘이
     * 공동 우승으로 그 자리에서 끝난다.
     */
    await page.waitForTimeout(3_000);
    await guests[0].close();
    await page.waitForURL('**/result**', { timeout: MATCH_TIMEOUT_MS });
    await expect(page.locator('.result-table')).toBeVisible({ timeout: 30_000 });
    return { guests };
}

test.describe('신고', () => {
    test.describe.configure({ timeout: 8 * 60_000 });

    test('결과 화면에서 신고하고 운영자가 큐에서 받는다', async ({ page, browser }) => {
        const reporter = await signUpAndLogIn(page, 'reporter');
        const context = await browser.newContext();
        const { guests } = await playedMatch(page, context, 'R');

        // 자기 줄에는 신고가 없다. 자기를 신고할 수 있으면 그 버튼은 설명할 수 없는 버튼이 된다.
        const selfRow = page.locator('.result-table tbody tr.is-self');
        await expect(selfRow.locator('.result-report-button')).toHaveCount(0);

        const target = page.locator('.result-table tbody tr:not(.is-self)').first();
        const targetNickname = (await target.locator('.result-player-cell > span').first().innerText()).trim();
        await target.locator('.result-report-button').click();

        await expect(page.getByRole('dialog')).toBeVisible();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: T.report.categories.CHEAT }).click();
        await dialog.getByRole('textbox').fill('벽을 통과하는 것처럼 보였습니다. 확인 부탁드립니다.');
        await dialog.getByRole('button', { name: T.report.submit }).click();
        await expect(page.getByText(T.report.sent)).toBeVisible({ timeout: 30_000 });
        await dialog.getByRole('button', { name: T.common.close }).click();

        // 같은 사람을 두 번 신고하면 거절당한다. 사건 하나에 신고자 하나다.
        await target.locator('.result-report-button').click();
        const again = page.getByRole('dialog');
        await again.getByRole('button', { name: T.report.categories.ABUSE }).click();
        await again.getByRole('textbox').fill('같은 사람을 한 번 더 신고해 봅니다.');
        await again.getByRole('button', { name: T.report.submit }).click();
        await expect(page.getByText(T.report.errors.duplicate)).toBeVisible({ timeout: 30_000 });
        await again.getByRole('button', { name: T.common.cancel }).click();

        await guests[1].close();
        await context.close();

        // 운영자가 그 신고를 큐에서 본다.
        grantAdmin(reporter.email);
        await page.goto('/admin');
        await page.getByRole('button', { name: T.admin.tabReports }).click();
        const row = page.locator('.admin-report-panel tbody tr').filter({ hasText: targetNickname }).first();
        await expect(row).toBeVisible({ timeout: 30_000 });
        // 게스트 대상이라는 것이 열기 전에 보여야 한다. 제재를 걸 수 없는 사건이기 때문이다.
        await expect(row).toContainText(T.admin.guestBadge);

        await row.click();
        const detail = page.getByRole('dialog');
        await expect(detail).toBeVisible({ timeout: 30_000 });
        await expect(detail).toContainText('벽을 통과하는 것처럼');
        // 게스트에게는 제재 대신 이유가 적혀 있어야 한다. 눌리지 않는 버튼은 이유를 설명하지 않는다.
        await expect(detail.getByText(T.admin.sanctionGuestBlocked)).toBeVisible();

        /*
         * 상태를 옮긴다. 사건은 열린 채로 남는다 — 상태만 바꾸고 끝나는 경우보다 이어서
         * 메모를 쓰거나 제재를 거는 경우가 많아서다. 큐는 뒤에서 갱신된다.
         */
        await detail.getByRole('button', { name: T.admin.caseApply }).click();
        await expect(detail).toContainText(T.admin.reportStatus.TRIAGED, { timeout: 30_000 });
        await page.keyboard.press('Escape');
        await expect(
            page.locator('.admin-report-panel tbody tr').filter({ hasText: targetNickname }).first(),
        ).toContainText(T.admin.reportStatus.TRIAGED, { timeout: 30_000 });

        grantAdmin(reporter.email, true);
        // 이 페이지는 아직 신고자로 로그인돼 있다. 다시 로그인하면 로그인 화면이 안 나와 멈춘다.
        await page.goto('/rooms');
        await deleteAccount(page, reporter);
    });
});
