import { expect, test, type Page } from '@playwright/test';
import { T, button, createRoom, deleteAccount, gotoHome, joinRoom, seatedPlayers, signUpAndLogIn } from '../support/app';

test.describe('방 만들기 · 목록 · 코드 참가', () => {
    test('공개 방을 만들면 목록에 뜨고 코드로 들어올 수 있다', async ({ page, browser }) => {
        const host = await signUpAndLogIn(page, 'room');
        const roomName = `E2E-${Date.now().toString(36)}`;
        const code = await createRoom(page, roomName);
        expect(code).toMatch(/^[A-Z0-9]{6}$/);

        const guest = await browser.newContext();
        const guestPage = await guest.newPage();
        await gotoHome(guestPage);
        await guestPage.goto('/rooms');
        // 목록은 Redis의 대기 방을 읽는다. 여기 안 뜨면 방 디렉터리 반영이 끊긴 것이다.
        await expect(guestPage.getByText(roomName)).toBeVisible({ timeout: 20_000 });

        await joinRoom(guestPage, code);
        await expect(seatedPlayers(guestPage)).toHaveCount(2, { timeout: 20_000 });
        await expect(seatedPlayers(page)).toHaveCount(2, { timeout: 20_000 });

        await button(guestPage, T.lobby.leave).click();
        await guestPage.waitForURL('**/rooms');
        await guest.close();

        await button(page, T.lobby.leave).click();
        await page.waitForURL('**/rooms');
        await deleteAccount(page, host);
    });

    test('비공개 방은 목록에 안 뜨고 비밀번호가 있어야 들어온다', async ({ page, browser }) => {
        const host = await signUpAndLogIn(page, 'private');
        const roomName = `E2E-P-${Date.now().toString(36)}`;
        const code = await createRoom(page, roomName, 'secret12');

        const guest = await browser.newContext();
        const guestPage = await guest.newPage();
        await gotoHome(guestPage);
        await guestPage.goto('/rooms');
        await expect(guestPage.getByText(roomName)).toHaveCount(0);

        // 틀린 비밀번호는 막혀야 한다.
        await guestPage.goto('/rooms/join?pw=true');
        await guestPage.getByLabel(T.rooms.roomId, { exact: true }).fill(code);
        await guestPage.getByLabel(T.rooms.password, { exact: true }).fill('wrongpw12');
        await button(guestPage, T.rooms.join).click();
        await expect(guestPage.locator('.status-message')).not.toBeEmpty({ timeout: 20_000 });
        expect(new URL(guestPage.url()).pathname).toBe('/rooms/join');

        await joinRoom(guestPage, code, 'secret12');
        await expect(seatedPlayers(guestPage)).toHaveCount(2, { timeout: 20_000 });

        await button(guestPage, T.lobby.leave).click();
        await guest.close();
        await button(page, T.lobby.leave).click();
        await page.waitForURL('**/rooms');
        await deleteAccount(page, host);
    });

    test('없는 방 코드는 분명한 이유와 함께 거절된다', async ({ page }) => {
        await gotoHome(page);
        await page.goto('/rooms/join');
        await page.getByLabel(T.rooms.roomId, { exact: true }).fill('ZZZZZZ');
        await button(page, T.rooms.join).click();
        await expect(page.getByText(T.rooms.errors.roomUnavailable)).toBeVisible({ timeout: 20_000 });
    });

    test('빠른 참가는 대기 중인 방으로 넣거나 없다고 말한다', async ({ page }) => {
        await gotoHome(page);
        await page.goto('/rooms');
        await button(page, T.rooms.quick).click();
        // 방이 있으면 로비로, 없으면 이유를 말해야 한다. 아무 일도 안 일어나면 안 된다.
        await Promise.race([
            page.waitForURL('**/lobby', { timeout: 25_000 }),
            expect(page.locator('.room-notice')).not.toBeEmpty({ timeout: 25_000 }),
        ]);
        if (new URL(page.url()).pathname.endsWith('/lobby')) {
            await button(page, T.lobby.leave).click();
            await page.waitForURL('**/rooms');
        }
    });

    test('공개 방 목록은 한 페이지에 정확히 6개씩 보여 준다', async ({ page, browser }) => {
        test.setTimeout(180_000);
        await gotoHome(page);
        const roomsContext = await browser.newContext({
            baseURL: new URL(page.url()).origin,
            viewport: { width: 640, height: 480 },
            reducedMotion: 'reduce',
        });
        const rooms: Page[] = [];
        try {
            for (let index = 0; index < 7; index += 1) {
                // sessionStorage가 탭별 게스트 신원을 분리하므로 로비 일곱 개를 동시에 유지할 수 있다.
                const host = await roomsContext.newPage();
                rooms.push(host);
                await gotoHome(host);
                await createRoom(host, `E2E-PAGE-${index}-${Date.now().toString(36)}`);
            }

            await page.goto('/rooms');
            await expect(page.locator('.room-grid .room-card')).toHaveCount(6, { timeout: 20_000 });
            await expect(page.getByRole('navigation', { name: T.rooms.pagination }))
                .toContainText('1 / 2');

            await button(page, T.nav.nextPage).click();
            await expect(page.locator('.room-grid .room-card')).toHaveCount(1, { timeout: 20_000 });
            await expect(page.getByRole('navigation', { name: T.rooms.pagination }))
                .toContainText('2 / 2');
        } finally {
            // 로비 소켓을 먼저 끊은 뒤 컨텍스트를 닫아 게스트 방과 브라우저 자원을 함께 정리한다.
            await Promise.all(rooms.map((room) =>
                room.goto('about:blank', { waitUntil: 'commit', timeout: 3_000 }).catch(() => undefined)));
            await Promise.race([
                roomsContext.close().catch(() => undefined),
                new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
            ]);
        }
    });
});
