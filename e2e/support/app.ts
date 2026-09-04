import { expect, type Locator, type Page } from '@playwright/test';
import ko from '../../client/src/locales/ko.json';
import { clearMail, waitForMail } from './mail';

/**
 * 화면을 무엇으로 찾을 것인가.
 *
 * `data-testid`를 뿌리는 대신 **로케일 파일의 문구**로 찾는다. 그러면 문구를 고칠 때
 * 점검이 같이 따라오고, 무엇보다 "사용자가 화면에서 읽는 그 글자"로 찾게 된다 —
 * 버튼에서 이름이 사라지면 점검도 못 찾는 것이 맞다. 접근성 이름이 곧 계약이다.
 */
export const T = ko;

export const PASSWORD = 'TestPass123!';

/** 같은 점검을 두 번 돌려도 겹치지 않는 계정. 도메인은 실제로 존재하지 않는 예약 도메인이다. */
export function newAccount(tag: string) {
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    return {
        email: `e2e-${tag}-${stamp}@example.com`,
        // 닉네임은 2~12자 영문·숫자·한글이다. 접두사를 짧게 잡아야 상한을 안 넘는다.
        nickname: `t${stamp}`.slice(0, 12),
        password: PASSWORD,
    };
}

export type Account = ReturnType<typeof newAccount>;

/** 이름으로 버튼 하나. RoundButton이 문구를 aria-label로 달아 두어 이름으로 잡힌다. */
export const button = (page: Page, name: string): Locator =>
    page.getByRole('button', { name, exact: true });

export async function gotoHome(page: Page): Promise<void> {
    await page.goto('/');
    // 게스트 신원 발급이 끝나야 화면이 나온다. 제목이 보이면 부팅이 끝난 것이다.
    await expect(button(page, T.titlePage.button.gameStart)).toBeVisible();
}

/** 가입 화면을 처음부터 끝까지. 인증 코드는 sink에서 읽는다. */
export async function signUp(page: Page, account: Account): Promise<void> {
    await clearMail(account.email);
    await page.goto('/signup');
    await page.getByLabel(T.auth.email, { exact: true }).fill(account.email);
    await button(page, T.auth.sendCode).click();
    await expect(page.getByText(T.auth.codeSent)).toBeVisible();

    const mail = await waitForMail(account.email, 'signup');
    await page.getByLabel(T.auth.nickname, { exact: true }).fill(account.nickname);
    await page.getByLabel(T.auth.code, { exact: true }).fill(mail.code);
    await page.getByLabel(T.auth.password, { exact: true }).fill(account.password);
    await button(page, T.auth.signup).click();

    await page.waitForURL('**/login');
}

export async function logIn(page: Page, account: Account): Promise<void> {
    await page.goto('/login');
    await page.getByLabel(T.auth.email, { exact: true }).fill(account.email);
    await page.getByLabel(T.auth.password, { exact: true }).fill(account.password);
    await button(page, T.auth.login).click();
    await page.waitForURL((url) => new URL(url).pathname === '/');
}

/** 가입 + 로그인. 대부분의 흐름은 "로그인된 상태"에서 시작한다. */
export async function signUpAndLogIn(page: Page, tag: string): Promise<Account> {
    const account = newAccount(tag);
    await signUp(page, account);
    await logIn(page, account);
    return account;
}

/**
 * 계정을 지운다. 점검이 남긴 계정이 DB에 쌓이지 않게 각 흐름의 끝에서 부른다.
 *
 * API를 직접 부르지 않고 **화면으로 몬다.** 사용자가 실제로 지나는 길이 여기이기도 하고,
 * 화면이 사라지면 이 정리 절차도 같이 실패해서 알려 준다.
 */
export async function deleteAccount(page: Page, account: Account): Promise<void> {
    await clearMail(account.email);
    await page.goto('/profile');

    /*
     * 여기서 게스트 화면이 나오면 정리가 실패한 게 아니라 **로그인이 풀린 것**이다.
     * 그대로 두면 "버튼을 못 찾았다"는 리포트가 나가서 진짜 이유가 묻힌다.
     */
    if (await page.getByText(T.profile.guestStats).isVisible().catch(() => false)) {
        throw new Error(
            `계정 세션이 사라졌습니다(${account.email}). 프로필이 게스트 화면입니다.`
            + ' refresh 토큰 회전 경합으로 보입니다.',
        );
    }

    await button(page, T.profile.deleteTitle).click();
    await page.getByRole('button', { name: T.profile.deleteSendCode }).click();
    await expect(page.getByText(T.profile.deleteCodeSent)).toBeVisible();

    const mail = await waitForMail(account.email, 'delete');
    await page.locator('.delete-code-field input').fill(mail.code);
    await page.getByRole('button', { name: T.profile.deleteConfirm }).click();

    await page.waitForURL((url) => new URL(url).pathname === '/', { timeout: 30_000 });
}

/** 방을 만들고 로비까지 간다. 반환값은 다른 사람이 들어올 때 쓰는 방 코드다. */
export async function createRoom(page: Page, name: string, password?: string): Promise<string> {
    await page.goto('/rooms/create');
    await page.getByLabel(T.rooms.roomName, { exact: true }).fill(name);
    if (password !== undefined) {
        await page.getByRole('checkbox', { name: T.rooms.usePassword }).click();
        await page.getByLabel(T.rooms.password, { exact: true }).fill(password);
    }
    await button(page, T.rooms.create).click();
    await page.waitForURL('**/lobby');
    return roomCode(page);
}

export async function roomCode(page: Page): Promise<string> {
    const code = page.locator('.lobby-room-code strong');
    await expect(code).toBeVisible();
    return (await code.innerText()).trim();
}

export async function joinRoom(page: Page, code: string, password?: string): Promise<void> {
    await page.goto(password === undefined ? '/rooms/join' : '/rooms/join?pw=true');
    await page.getByLabel(T.rooms.roomId, { exact: true }).fill(code);
    if (password !== undefined) await page.getByLabel(T.rooms.password, { exact: true }).fill(password);
    await button(page, T.rooms.join).click();
    await page.waitForURL('**/lobby');
}

/** 로비에 몇 명이 앉아 있는가. 빈 자리에는 `is-empty`가 붙으므로 그 반대를 센다. */
export function seatedPlayers(page: Page): Locator {
    return page.locator('.lobby-player-grid .lobby-player-card:not(.is-empty)');
}

/**
 * 방장의 시작 버튼.
 *
 * 이름으로 찾지 않는다 — 누가 들어올 때마다 시작 잠금이 걸려 글자가 "시작"과
 * "N초 뒤 시작 가능" 사이를 오간다. 이름으로 잡으면 그 순간마다 점검이 흔들린다.
 */
export function startButton(page: Page): Locator {
    return page.locator('.lobby-footer-actions button').last();
}

/**
 * 잠금이 풀릴 때까지 기다렸다가 시작한다.
 *
 * "풀렸는지 보고 → 누른다"로는 부족하다. 시작 잠금은 **누가 들어올 때마다 5초씩 다시 걸리고**
 * (`START_LOCK_ON_JOIN_MS`), 확인과 클릭 사이에 lobby.state가 한 번 도착하면 그새 다시 잠긴다.
 * 사람이라면 그냥 한 번 더 누르는 상황이라, 여기서도 방으로 넘어갈 때까지 다시 누른다.
 */
export async function startMatch(page: Page, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await expect(startButton(page)).toBeEnabled({ timeout: 10_000 });
            await startButton(page).click({ timeout: 5_000 });
            await page.waitForURL('**/game**', { timeout: 10_000 });
            return;
        } catch {
            // 잠금이 다시 걸렸거나 눌린 것이 서버에 안 닿았다. 다음 바퀴에서 다시 시도한다.
            if (new URL(page.url()).pathname.startsWith('/game')) return;
        }
    }
    throw new Error(`${timeoutMs}ms 안에 경기를 시작하지 못했습니다. 지금 주소: ${page.url()}`);
}
