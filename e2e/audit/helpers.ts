import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
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
    await page.getByRole('button', { name: '로그인', exact: true }).click();
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
    const response = await context.request.post('/api/auth/login', { data: { email: account.email, password: account.password } });
    expect(response.status(), 'synthetic account login').toBe(201);
    const data = await response.json();
    if (typeof data.accessToken !== 'string') throw new Error('Login did not issue access');
    return { Authorization: `Bearer ${data.accessToken}` };
}
