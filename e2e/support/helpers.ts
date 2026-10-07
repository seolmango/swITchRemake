import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { buildSwitchRound, searchPow } from 'shared';
import postgres from 'postgres';
import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';

export function database() {
    if (process.env.AUDIT_STACK !== 'true' || process.env.DB_HOST !== 'postgres'
        || !/^audit_[a-z0-9_]+$/.test(process.env.DB_NAME ?? '') || !process.env.DB_PASSWORD) {
        throw new Error('Refusing non-audit database');
    }
    return postgres({ host: 'postgres', port: 5432, database: process.env.DB_NAME,
        username: 'audit', password: process.env.DB_PASSWORD, ssl: false, max: 2,
        connect_timeout: 10, idle_timeout: 5 });
}
export async function seedAccount(role: 'USER' | 'ADMIN' = 'USER') {
    const suffix = randomBytes(4).toString('hex');
    const account = { id: 0, email: `audit${suffix}@switch.test`, nickname: `검증${suffix}`,
        password: `Au${randomBytes(6).toString('hex')}!` };
    const db = database();
    try {
        const hash = await bcrypt.hash(account.password, 10);
        const [row] = await db`insert into users (email, password_hash, nickname, role,
            terms_version, terms_agreed_at, privacy_version, privacy_agreed_at)
            values (${account.email}, ${hash}, ${account.nickname}, ${role}, '1.0', now(), '1.0', now()) returning id`;
        account.id = row!.id;
        return account;
    } finally { await db.end(); }
}
export async function isolatedContext(browser: Browser, options: { width?: number; height?: number } = {}) {
    const context = await browser.newContext({ baseURL: 'http://web', locale: 'ko-KR',
        viewport: { width: options.width ?? 1440, height: options.height ?? 900 }, acceptDownloads: true });
    const external: string[] = [];
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (!['http:', 'https:'].includes(url.protocol) || url.origin === 'http://web') return route.continue();
        external.push(`${url.protocol}//${url.hostname}`);
        await route.abort('blockedbyclient');
    });
    await context.addInitScript(() => {
        let prior = { state: {} };
        try { prior = JSON.parse(localStorage.getItem('switch-settings') ?? '{}'); } catch { /* corrupt local preference */ }
        localStorage.setItem('switch-settings', JSON.stringify({
            version: 2, state: { ...prior.state, masterVolume: 0, bgmEnabled: false },
        }));
    });
    return { context, external };
}
export async function login(page: Page, account: { email: string; password: string }) {
    await page.goto('/login');
    await page.getByRole('textbox', { name: '이메일', exact: true }).fill(account.email);
    await page.getByLabel('비밀번호', { exact: true }).fill(account.password);
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login');
    const check = watchHumanCheck(page);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await completeHumanChallenge(page, check);
    const response = await responsePromise;
    await expect(page.getByRole('button', { name: '게임 시작', exact: true })).toBeVisible();
    const data = await response.json();
    if (typeof data.accessToken !== 'string') throw new Error('UI login did not issue access');
    const headers = { Authorization: `Bearer ${data.accessToken}` };
    // Full navigation bootstraps/rotates the live identity. Later API assertions
    // must use the current credential the real browser actually sends.
    page.on('request', request => {
        const url = new URL(request.url());
        const authorization = request.headers()['authorization'];
        if (url.origin === 'http://web' && url.pathname.startsWith('/api/') && authorization?.startsWith('Bearer ')) headers.Authorization = authorization;
    });
    return headers;
}
// Tokens stay in memory, never assertions, console output, traces, or artifacts.
export async function apiLogin(context: BrowserContext, account: { email: string; password: string }) {
    // 로그인은 시도마다 사람 확인 증명이 필요하다. 새 계정은 충전(작업 증명)만으로 받는다.
    const issued = await (await context.request.post('/api/auth/human-challenge', { data: { purpose: 'login', subject: account.email } })).json();
    const powCounter = searchPow(issued.pow.nonce, issued.pow.bits, 0, 1 << 26);
    // 한 IP에서 로그인이 몰리면 서버가 장면을 요구한다(학교·공유기 뒤의 여러 사람과 같은 상황).
    // 그때는 장면이 실제로 그 시각까지 흐른 뒤에 정답을 낸다.
    let answer: { slot: number; atMs: number } | undefined;
    if (issued.round?.kind === 'switch') {
        const round = buildSwitchRound(issued.round.seed);
        await new Promise((resolve) => setTimeout(resolve, round.openAt + 300));
        answer = { slot: round.target, atMs: round.openAt + 200 };
    }
    const verified = await context.request.post('/api/auth/human-challenge/verify', { data: { challengeToken: issued.challengeToken, powCounter, ...(answer ? { answer } : {}) } });
    expect(verified.status(), 'human check verifies').toBe(201);
    const { proofToken } = await verified.json();
    const response = await context.request.post('/api/auth/login', { data: { email: account.email, password: account.password, humanProof: proofToken } });
    expect(response.status(), 'synthetic account login').toBe(201);
    const data = await response.json();
    if (typeof data.accessToken !== 'string') throw new Error('Login did not issue access');
    return { Authorization: `Bearer ${data.accessToken}` };
}

export interface HumanCheckWatch {
    issued: Promise<{ round: { kind: 'switch' | 'radio'; seed: number } | null }>;
    verified: Promise<import('@playwright/test').Response>;
}

/**
 * 발급과 검증 응답을 **둘 다 클릭 전에** 붙잡는다. 새 계정은 충전이 0.1초 안에 끝나서, 발급 응답을
 * 받은 뒤에 검증 대기를 걸면 검증 요청이 이미 지나가 버린다(2026-10-05 감사에서 실제로 놓쳤다).
 */
export function watchHumanCheck(page: Page): HumanCheckWatch {
    const issued = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/auth/human-challenge')
        && response.request().method() === 'POST').then((response) => response.json());
    const verified = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/auth/human-challenge/verify'));
    return { issued, verified };
}

export async function completeHumanChallenge(page: Page, check: HumanCheckWatch): Promise<void> {
    const issued = await check.issued;
    if (issued.round?.kind === 'switch') {
        const dialog = page.getByRole('dialog', { name: '스위치 판정', exact: true });
        await expect(dialog).toBeVisible();
        const round = buildSwitchRound(issued.round.seed);
        await dialog.getByRole('button', { name: '시작', exact: true }).click();
        await page.waitForTimeout(round.openAt + 250);
        await page.keyboard.press(`Digit${round.target}`);
    }
    expect((await check.verified).ok(), 'human check verifies').toBe(true);
}
