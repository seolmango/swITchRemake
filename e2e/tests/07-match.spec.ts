import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { T, createRoom, deleteAccount, gotoHome, joinRoom, seatedPlayers, signUpAndLogIn, startMatch } from '../support/app';

/**
 * 경기는 자기장 틱과 최대 경기 시간 등 서버 판정으로 끝난다. 살아남은 수는 하나일 수도
 * 여럿일 수도 있으므로 종료 시점은 맵 타임라인에 맡기고 넉넉히 기다린다.
 */
const MATCH_TIMEOUT_MS = 5 * 60_000;

async function guestInRoom(context: BrowserContext, code: string): Promise<Page> {
    const page = await context.newPage();
    await gotoHome(page);
    await joinRoom(page, code);
    return page;
}

/** 방장 + 게스트 둘. 최소 인원(3)을 채워 시작할 수 있는 상태까지 만든다. */
async function threePlayerRoom(page: Page, context: BrowserContext, tag: string) {
    const code = await createRoom(page, `E2E-${tag}-${Date.now().toString(36)}`);
    const one = await guestInRoom(context, code);
    const two = await guestInRoom(context, code);
    await expect(seatedPlayers(page)).toHaveCount(3, { timeout: 30_000 });
    // 시작 잠금이 풀리기를 여기서 기다리지 않는다 — 누가 들어올 때마다 다시 걸려서,
    // 기다려 봐야 `startMatch`가 어차피 다시 확인해야 한다.
    return { code, guests: [one, two] as const };
}

test.describe('경기 · 도중 이탈 · 결과', () => {
    // 경기 하나가 끝나기를 기다리는 흐름이 있어서 넉넉히 잡는다. 방을 세 명으로 채우고
    // 셋 다 인게임 화면에 들어가는 데만도 실측 60~150초가 걸린다.
    test.describe.configure({ timeout: MATCH_TIMEOUT_MS + 300_000 });

    test('경기를 시작하면 세 명 모두 인게임 화면으로 들어간다', async ({ page, browser }) => {
        const host = await signUpAndLogIn(page, 'ingame');
        const context = await browser.newContext();
        const { guests } = await threePlayerRoom(page, context, 'G');

        await startMatch(page);
        // 셋을 차례로 기다리면 최악의 경우 대기 시간이 세 배가 된다. 어차피 동시에 들어간다.
        await Promise.all([page, ...guests].map(async (player) => {
            await player.waitForURL('**/game**', { timeout: 90_000 });
            // HUD가 떠야 실제로 스냅샷이 오고 있는 것이다. 로딩 오버레이에서 멈추면 실패다.
            await expect(player.locator('.game-hud[data-hud-ready="true"]')).toBeVisible({ timeout: 90_000 });
        }));

        // 움직이고 스킬을 쓰고 이모지를 낸다. 서버가 거절하면 화면에 알림이 뜬다.
        await page.keyboard.down('w');
        await page.waitForTimeout(600);
        await page.keyboard.up('w');
        await page.keyboard.press('Shift');
        await page.waitForTimeout(400);
        await expect(page.getByText(T.game.connectionLost)).toHaveCount(0);

        for (const player of guests) await player.close();
        await context.close();
        await page.goto('/rooms');
        await deleteAccount(page, host);
    });

    test('경기 도중 나가도 남은 사람의 경기는 계속되고 결과가 나온다', async ({ page, browser }) => {
        const host = await signUpAndLogIn(page, 'leave');
        const context = await browser.newContext();
        const { guests } = await threePlayerRoom(page, context, 'L');

        await startMatch(page);
        await page.waitForURL('**/game**', { timeout: 60_000 });
        for (const player of guests) await player.waitForURL('**/game**', { timeout: 60_000 });

        // 한 명이 도중에 창을 닫으면 즉시 아웃된다. 3인 경기라 남은 둘의 공동 승리로 바로 끝난다.
        await page.waitForTimeout(3_000);
        await guests[0].close();

        await page.waitForURL('**/result**', { timeout: 30_000 });
        await expect(page.locator('.result-table')).toBeVisible({ timeout: 30_000 });

        // 이 시나리오는 정확히 두 생존자지만 결과 UI 자체는 winnerIds 길이를 계약으로 삼는다.
        await expect(page.locator('.result-winners')).toHaveAttribute('data-winner-count', '2');
        const returnTimer = page.getByRole('progressbar', { name: T.result.returnTimerLabel });
        await expect(returnTimer).toHaveAttribute('aria-valuemax', '10');
        const remaining = Number(await returnTimer.getAttribute('aria-valuenow'));
        expect(remaining).toBeGreaterThanOrEqual(0);
        expect(remaining).toBeLessThanOrEqual(10);

        // 계정 사용자에게는 이번 경기의 XP 내역이 보여야 한다.
        await expect(page.locator('.result-reward')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('.result-reward header strong')).toContainText('XP');
        // 다섯 항목(참가·승리·태그·swITch·생존)이 모두 서 있어야 "무엇을 더 하면 되는지"를 읽을 수 있다.
        await expect(page.locator('.result-reward li')).toHaveCount(5);
        await expect(page.locator('.result-reward li').filter({ hasText: T.result.xpSurvival })).toBeVisible();
        // 참가 몫만으로도 총합은 0보다 크다. 0이면 XP 적립 자체가 끊긴 것이다.
        const total = Number((await page.locator('.result-reward header strong').innerText()).replace(/[^0-9]/g, ''));
        expect(total).toBeGreaterThan(0);

        await guests[1].close();
        await context.close();
        await page.goto('/rooms');
        await deleteAccount(page, host);
    });

    /**
     * 한동안 실패하던 흐름이다. 새로고침으로 WebSocket이 끊긴 직후 registry가 큐에 넣어
     * 둔 낡은 자리 해제가, 그 사이 되살아난 `user:{id}:active-room`을 지우고 있었다
     * (a8830f0). flush 직전에 명단을 다시 보게 고쳤다.
     *
     * 경합이라 매번 재현되지 않았다. 그래서 이 점검이 통과한다고 해서 다 끝났다는 뜻은
     * 아니고, 다시 빨간불이 되면 그때는 같은 자리를 의심하면 된다.
     */
    test('경기 중 새로고침하면 즉시 아웃되고 보존된 자리로 돌아간다', async ({ page, browser }) => {
        const host = await signUpAndLogIn(page, 'resume');
        const context = await browser.newContext();
        const { guests } = await threePlayerRoom(page, context, 'F');

        await startMatch(page);
        await page.waitForURL('**/game**', { timeout: 60_000 });
        await expect(page.locator('.game-hud[data-hud-ready="true"]')).toBeVisible({ timeout: 60_000 });

        await page.waitForTimeout(3_000);
        await page.reload();
        /*
         * 연결이 끊긴 순간 경기에서는 아웃이다. 다만 자리는 5초 보존되므로 그 안에 돌아오면
         * 진행 중인 경기에는 관전으로, 이미 3인 경기가 끝났다면 결과 또는 같은 방 로비로 붙는다.
         * 어느 화면이 먼저 보일지는 종료 결과 저장과 새 티켓 발급 순서에 달려 있다.
         *
         * 이 점검이 지키는 것은 즉시 아웃 규칙과 별개로 **보존된 자리와 방에 복귀한다**는 것이다.
         */
        await expect(
            page.locator('.game-hud[data-hud-ready="true"]')
                .or(page.locator('.result-table'))
                .or(page.getByRole('button', { name: T.lobby.leave })),
        ).toBeVisible({ timeout: 60_000 });
        await expect(page.getByText(T.lobby.resumeFailed)).toHaveCount(0);
        // 시작 신호를 놓친 연결이 "시작을 기다리는" 화면에 갇히던 버그가 여기서 잡힌다.
        await expect(page.getByText(T.game.waitingStart)).toHaveCount(0);

        for (const player of guests) await player.close();
        await context.close();
        await page.goto('/rooms');
        await deleteAccount(page, host);
    });

    test('경기 중 들어온 사람은 로비에서 기다리고 다음 경기부터 참가한다', async ({ page, browser }) => {
        const host = await signUpAndLogIn(page, 'latejoin');
        const context = await browser.newContext();
        const { code, guests } = await threePlayerRoom(page, context, 'J');

        await startMatch(page);
        await Promise.all([page, ...guests].map(async (player) => {
            await player.waitForURL('**/game**', { timeout: 90_000 });
            await expect(player.locator('.game-hud[data-hud-ready="true"]')).toBeVisible({ timeout: 90_000 });
        }));

        const late = await guestInRoom(context, code);
        await expect(late).toHaveURL(/\/lobby$/u);
        const lateCard = late.locator('.lobby-player-card.is-self');
        await expect(lateCard).toBeVisible();
        expect(await lateCard.getAttribute('aria-label')).toContain(T.lobby.roles.waiting);
        await expect(late.locator('.game-hud')).toHaveCount(0);
        await expect(late.getByRole('button', { name: T.lobby.roles.spectator, exact: true })).toHaveCount(0);

        // 진행 중 명단에 끼어들거나 시작 신호를 뒤늦게 받지 않는지 잠깐 더 지켜본다.
        await late.waitForTimeout(2_000);
        await expect(late).toHaveURL(/\/lobby$/u);

        await page.waitForURL('**/result**', { timeout: MATCH_TIMEOUT_MS });
        await expect(page.locator('.result-table')).toBeVisible({ timeout: 30_000 });
        const winnerCount = Number(await page.locator('.result-winners').getAttribute('data-winner-count'));
        expect(winnerCount).toBeGreaterThanOrEqual(1);
        expect(winnerCount).toBeLessThanOrEqual(3);

        // 서버가 정한 10초가 지나면 원래 참가자도 로비로 돌아오고, 대기자는 일반 참가자가 된다.
        await page.waitForURL('**/lobby', { timeout: 15_000 });
        await expect(seatedPlayers(page)).toHaveCount(4, { timeout: 20_000 });
        expect(await lateCard.getAttribute('aria-label')).toContain(T.lobby.roles.player);

        await startMatch(page);
        await late.waitForURL('**/game**', { timeout: 90_000 });
        await expect(late.locator('.game-hud[data-hud-ready="true"]')).toBeVisible({ timeout: 90_000 });

        for (const player of [...guests, late]) await player.close();
        await context.close();
        await page.goto('/rooms');
        await deleteAccount(page, host);
    });
});
