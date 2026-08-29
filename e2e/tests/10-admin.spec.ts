import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { T, deleteAccount, logIn, signUpAndLogIn } from '../support/app';

/** 첫 관리자는 DB에 닿을 수 있는 사람만 만들 수 있다. 화면 안에 승격 버튼을 두지 않은 이유다. */
function grantAdmin(email: string, revoke = false): void {
    execFileSync(
        process.execPath,
        [resolve(__dirname, '..', '..', 'scripts', 'grant-admin.cjs'), email, ...(revoke ? ['--revoke'] : [])],
        { cwd: resolve(__dirname, '..', '..'), stdio: 'pipe' },
    );
}

test.describe('운영자 화면', () => {
    test('평범한 계정에게는 운영자 메뉴가 없고 주소로 들어가도 막힌다', async ({ page }) => {
        const account = await signUpAndLogIn(page, 'notadmin');

        await expect(page.getByRole('button', { name: T.nav.admin })).toHaveCount(0);
        await page.goto('/admin');
        await expect(page.getByText(T.admin.denied)).toBeVisible({ timeout: 20_000 });

        await deleteAccount(page, account);
    });

    test('관리자는 서버 상태·트래픽·유저 수를 한 화면에서 본다', async ({ page }) => {
        const account = await signUpAndLogIn(page, 'admin');
        grantAdmin(account.email);
        // 역할은 토큰이 아니라 DB에서 읽으므로 다시 로그인할 필요는 없지만,
        // 화면의 메뉴 힌트는 부팅 때 한 번 받아 온다. 한 번만 다시 띄운다 — 연속으로 두 번
        // 띄우면 refresh 토큰 회전이 겹쳐 로그인이 풀린다.
        await page.reload();

        await expect(page.getByRole('button', { name: T.nav.admin })).toBeVisible({ timeout: 20_000 });
        await page.getByRole('button', { name: T.nav.admin }).click();
        await page.waitForURL('**/admin');

        await expect(page.locator('.admin-kpi')).toHaveCount(6, { timeout: 20_000 });
        await expect(page.getByText(T.admin.kpiInGame)).toBeVisible();
        await expect(page.getByText(T.admin.kpiUsers)).toBeVisible();
        await expect(page.getByText(T.admin.registryDegraded)).toHaveCount(0);

        // 인게임 서버가 최소 한 대는 살아 있어야 경기가 돌아간다.
        await expect(page.locator('.admin-panel').first().locator('tbody tr')).not.toHaveCount(0);
        await expect(page.getByText(T.admin.noGameServers)).toHaveCount(0);
        // 매칭 서버는 자기 자신을 반드시 보고한다.
        await expect(page.getByText(T.admin.noMatchServers)).toHaveCount(0);

        // 자동 갱신을 껐다 켜도 화면이 살아 있어야 한다.
        await page.getByRole('button', { name: T.admin.autoRefresh }).click();
        await expect(page.getByRole('button', { name: T.admin.autoRefresh })).toHaveAttribute('aria-pressed', 'false');

        grantAdmin(account.email, true);
        await logIn(page, account);
        await deleteAccount(page, account);
    });

    test('권한을 빼면 그 즉시 막힌다', async ({ page }) => {
        const account = await signUpAndLogIn(page, 'demote');
        grantAdmin(account.email);
        await page.goto('/admin');
        await expect(page.locator('.admin-kpi').first()).toBeVisible({ timeout: 20_000 });

        // 토큰에 역할이 실려 있으면 여기서 토큰 수명만큼 관리자로 남는다. 새로고침 없이 막혀야 한다.
        grantAdmin(account.email, true);
        await page.reload();
        await expect(page.getByText(T.admin.denied)).toBeVisible({ timeout: 30_000 });

        await deleteAccount(page, account);
    });
});
