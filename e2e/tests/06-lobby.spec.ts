import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { T, button, createRoom, deleteAccount, gotoHome, joinRoom, seatedPlayers, signUpAndLogIn, startButton } from '../support/app';

/** 게스트 손님 하나를 방에 앉힌다. 3인이 모여야 시작할 수 있어서 대부분의 흐름이 이걸 쓴다. */
async function guestInRoom(context: BrowserContext, code: string): Promise<Page> {
    const page = await context.newPage();
    await gotoHome(page);
    await joinRoom(page, code);
    return page;
}

test.describe('대기실', () => {
    test('방장은 맵과 잠금을 바꾸고, 참가자는 스킬을 고른다', async ({ page, browser }) => {
        const host = await signUpAndLogIn(page, 'lobby');
        const code = await createRoom(page, `E2E-L-${Date.now().toString(36)}`);

        const mapName = page.locator('.lobby-map-picker strong');
        const before = await mapName.innerText();
        await page.getByRole('button', { name: T.lobby.nextMap }).click();
        await expect(mapName).not.toHaveText(before, { timeout: 15_000 });

        const lock = page.getByRole('button', { name: T.lobby.unlocked });
        await lock.click();
        await expect(page.getByRole('button', { name: T.lobby.locked })).toBeVisible({ timeout: 15_000 });
        await page.getByRole('button', { name: T.lobby.locked }).click();
        await expect(page.getByRole('button', { name: T.lobby.unlocked })).toBeVisible({ timeout: 15_000 });

        // 스킬 바꾸기. 서버가 확인해 준 뒤에야 화면이 바뀐다(낙관적 갱신을 안 한다).
        await page.locator('.lobby-player-card:not(.is-empty)').first()
            .getByRole('button', { name: T.lobby.changeSkill }).click();
        await page.getByRole('button', { name: T.lobby.skills.flash }).click();
        await expect(page.locator('.lobby-footer-status')).toContainText(T.lobby.skills.flash, { timeout: 15_000 });

        await button(page, T.lobby.leave).click();
        await page.waitForURL('**/rooms');
        await deleteAccount(page, host);
    });

    test('사람이 모자라면 시작 버튼이 잠겨 있고 이유를 말한다', async ({ page, browser }) => {
        const host = await signUpAndLogIn(page, 'minplayers');
        const code = await createRoom(page, `E2E-M-${Date.now().toString(36)}`);

        await expect(page.locator('.lobby-footer-status')).toContainText('3', { timeout: 15_000 });
        await expect(startButton(page)).toBeDisabled();

        const guests = await browser.newContext();
        const one = await guestInRoom(guests, code);
        const two = await guestInRoom(guests, code);
        await expect(seatedPlayers(page)).toHaveCount(3, { timeout: 25_000 });
        // 세 명이 모이면 시작 잠금이 풀린다(사람이 들어올 때마다 잠금이 다시 걸린다).
        await expect(startButton(page)).toBeEnabled({ timeout: 40_000 });

        await one.close();
        await two.close();
        await guests.close();
        await button(page, T.lobby.leave).click();
        await deleteAccount(page, host);
    });

    test('방장이 참가자를 내보내면 그 사람은 방에서 나간다', async ({ page, browser }) => {
        const host = await signUpAndLogIn(page, 'kick');
        const code = await createRoom(page, `E2E-K-${Date.now().toString(36)}`);

        const guests = await browser.newContext();
        const guestPage = await guestInRoom(guests, code);
        await expect(seatedPlayers(page)).toHaveCount(2, { timeout: 25_000 });

        await page.locator('.lobby-player-card.has-host-actions').first()
            .locator('.lobby-host-actions button.is-danger').click();
        await page.getByRole('button', { name: T.lobby.kick, exact: true }).last().click();

        await expect(seatedPlayers(page)).toHaveCount(1, { timeout: 25_000 });
        // 내보내진 쪽도 방에서 나가고, 왜 나갔는지 읽을 수 있어야 한다.
        await guestPage.waitForURL('**/rooms', { timeout: 25_000 });
        await expect(guestPage.getByText(T.lobby.youWereKicked)).toBeVisible({ timeout: 15_000 });

        await guests.close();
        await button(page, T.lobby.leave).click();
        await deleteAccount(page, host);
    });

    test('방장을 넘기면 시작 권한도 같이 넘어간다', async ({ page, browser }) => {
        const host = await signUpAndLogIn(page, 'passhost');
        const code = await createRoom(page, `E2E-H-${Date.now().toString(36)}`);

        const guests = await browser.newContext();
        const guestPage = await guestInRoom(guests, code);
        await expect(seatedPlayers(page)).toHaveCount(2, { timeout: 25_000 });

        await page.locator('.lobby-player-card.has-host-actions').first()
            .locator('.lobby-host-actions button').first().click();
        await page.getByRole('button', { name: T.lobby.passHost, exact: true }).last().click();

        // 넘긴 쪽에서는 시작 버튼이 사라지고, 받은 쪽에 생긴다.
        await expect(page.locator('.lobby-footer-actions button')).toHaveCount(1, { timeout: 25_000 });
        await expect(guestPage.getByRole('button', { name: T.lobby.unlocked })).toBeVisible({ timeout: 25_000 });

        await guestPage.close();
        await guests.close();
        await button(page, T.lobby.leave).click();
        await deleteAccount(page, host);
    });

    test('새로고침해도 방으로 돌아온다', async ({ page }) => {
        const host = await signUpAndLogIn(page, 'reload');
        const roomName = `E2E-R-${Date.now().toString(36)}`;
        await createRoom(page, roomName);

        await page.reload();
        // 재접속이 붙지 않으면 "다시 연결하는 중"에서 멈춘다.
        await expect(page.locator('.lobby-room-code strong')).toBeVisible({ timeout: 30_000 });
        await expect(seatedPlayers(page)).toHaveCount(1, { timeout: 30_000 });

        await button(page, T.lobby.leave).click();
        await page.waitForURL('**/rooms');
        await deleteAccount(page, host);
    });
});
