import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('public screens stay within resized desktop and mobile viewports without audio', async ({ browser }) => {
    test.setTimeout(240_000);
    const baseURL = process.env.E2E_BASE_URL || 'https://switch-dev-193234.koreacentral.cloudapp.azure.com';
    const dir = resolve('e2e/artifacts/azure-20261004/layout');
    const viewports = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
    const paths = ['/', '/login', '/signup', '/reset-password', '/rooms', '/rooms/create', '/rooms/join', '/profile', '/settings', '/how-to-play', '/replay'];
    // Optional IDs must refer to existing test data accessible to this ordinary guest session.
    // Layout checks neither create rooms nor bypass result/room authorization.
    if (process.env.E2E_LAYOUT_ROOM_ID) paths.push(`/rooms/${encodeURIComponent(process.env.E2E_LAYOUT_ROOM_ID)}/lobby`);
    if (process.env.E2E_LAYOUT_MATCH_ID) paths.push(`/matches/${encodeURIComponent(process.env.E2E_LAYOUT_MATCH_ID)}/result`);
    const measurements: unknown[] = [];
    const errors: string[] = [];
    await mkdir(dir, { recursive: true });
    // Reuse the same identity across nine navigations, resizing each loaded screen in place.
    // This tests responsive transitions without generating 27 authentication bootstraps.
    const context = await browser.newContext({ baseURL, viewport: viewports[0], locale: 'ko-KR' });
    await context.addInitScript(() => localStorage.setItem('switch-settings', JSON.stringify({ version: 2, state: { masterVolume: 0, bgmEnabled: false } })));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
        if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
    });
    try {
        for (const path of paths) {
            await page.setViewportSize(viewports[0]!);
            await page.goto(path);
            await expect(page.locator('h1')).toBeVisible({ timeout: 15_000 });
            for (const viewport of viewports) {
                await page.setViewportSize(viewport);
                const variants = path === '/settings' ? ['general', 'sound', 'game', 'keymap', 'security'] : [null];
                for (const [tabIndex, variant] of variants.entries()) {
                if (variant) {
                    await page.getByRole('tab').nth(tabIndex).click();
                    await expect(page.getByRole('tab').nth(tabIndex)).toHaveAttribute('aria-selected', 'true');
                }
                await page.evaluate(async () => {
                    await document.fonts.ready;
                    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                    // Resizing changes the shared buttons' 200ms transitions. Measure their
                    // settled boxes, rather than the transient coordinates between two layouts.
                    await Promise.allSettled(document.getAnimations().filter(animation => animation instanceof CSSTransition).map(animation => animation.finished));
                    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                });
                const state = await page.evaluate(() => {
                    const container = document.querySelector<HTMLElement>('.game-container');
                    const menu = container?.classList.contains('responsive-form-container') && matchMedia('(max-width: 640px) and (orientation: portrait)').matches;
                    const table = document.querySelector<HTMLElement>('.result-table-wrap');
                    const homeButtons = [...document.querySelectorAll<HTMLElement>('.title-screen > .round-button')];
                    const logo = document.querySelector<SVGElement>('.title-logo');
                    return {
                        width: innerWidth, height: innerHeight,
                        scrollWidth: document.documentElement.scrollWidth,
                        scrollHeight: document.documentElement.scrollHeight,
                        menu: Boolean(menu),
                        home: logo ? {
                            logo: logo.getBoundingClientRect().toJSON(),
                            buttons: homeButtons.map(button => {
                                const rect = button.getBoundingClientRect();
                                const topElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                                return { rect: rect.toJSON(), unobscured: topElement?.closest('button') === button };
                            }),
                        } : null,
                        container: container ? { clientWidth: container.clientWidth, scrollWidth: container.scrollWidth, clientHeight: container.clientHeight, scrollHeight: container.scrollHeight } : null,
                        // A result table is allowed to scroll inside its own panel; the page is not.
                        resultTable: table ? { clientWidth: table.clientWidth, scrollWidth: table.scrollWidth, overflowX: getComputedStyle(table).overflowX } : null,
                        buttons: [...document.querySelectorAll('button')].filter(button => {
                            const rect = button.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0 && getComputedStyle(button).visibility !== 'hidden';
                        }).map(button => ({
                            primary: button.classList.contains('round-button'),
                            text: button.getAttribute('aria-label') || button.textContent?.trim(),
                            rect: button.getBoundingClientRect().toJSON(),
                            labelFontSize: button.querySelector('svg text') ? getComputedStyle(button.querySelector('svg text')!).fontSize : getComputedStyle(button).fontSize,
                        })),
                    };
                });
                measurements.push({ viewport, path, variant, finalPath: new URL(page.url()).pathname, ...state });
                // Capture every viewport even when a layout assertion fails, so the report can
                // show the offending geometry instead of stopping at the first bad page.
                await page.screenshot({ path: resolve(dir, `${viewport.width}x${viewport.height}-${path === '/' ? 'home' : path.slice(1).replaceAll('/', '-')}${variant ? `-${variant}` : ''}.png`), animations: 'disabled' });
                expect.soft(state.scrollWidth, `${path} ${viewport.width}x${viewport.height}: document horizontal overflow`).toBeLessThanOrEqual(viewport.width + 1);
                if (path === '/') {
                    expect.soft(state.home?.buttons.length, 'home: both primary actions exist').toBe(2);
                    for (const button of state.home?.buttons ?? []) {
                        expect.soft(button.rect.left, 'home: primary action left is visible').toBeGreaterThanOrEqual(0);
                        expect.soft(button.rect.top, 'home: primary action top is visible').toBeGreaterThanOrEqual(0);
                        expect.soft(button.rect.right, 'home: primary action right is visible').toBeLessThanOrEqual(viewport.width);
                        expect.soft(button.rect.bottom, 'home: primary action bottom is visible').toBeLessThanOrEqual(viewport.height);
                        expect.soft(button.unobscured, 'home: primary action is not covered by another element').toBe(true);
                    }
                    if (state.home?.buttons.length === 2) {
                        expect.soft(state.home.logo.bottom, 'home: logo comes before the start action').toBeLessThanOrEqual(state.home.buttons[0]!.rect.top);
                        expect.soft(state.home.buttons[0]!.rect.bottom, 'home: primary actions do not overlap').toBeLessThanOrEqual(state.home.buttons[1]!.rect.top);
                    }
                }
                if (state.menu && state.container) {
                    expect.soft(state.container.scrollWidth, `${path}: portrait menu horizontal overflow`).toBeLessThanOrEqual(state.container.clientWidth + 1);
                    expect.soft(state.buttons.filter(button => button.primary).every(button => button.rect.width >= 40 && button.rect.height >= 40), `${path}: portrait primary controls remain usable`).toBe(true);
                }
                if (state.menu && state.resultTable && state.resultTable.scrollWidth > state.resultTable.clientWidth) {
                    expect.soft(['auto', 'scroll'], `${path}: wide result table stays within a scrollable panel`).toContain(state.resultTable.overflowX);
                }
                }
            }
        }
    } finally {
        await writeFile(resolve(dir, 'measurements.json'), JSON.stringify({ measurements, errors }, null, 2));
        await context.close();
    }
});
