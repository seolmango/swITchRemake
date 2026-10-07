import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/*
 * 화면 × 테마 × 뷰포트 행렬에서 "박스를 뚫고 나간 것"을 기계로 잡는다.
 *
 * `layout.spec.ts`는 문서 가로폭만 잰다. 그것으로는 잘라내는 부모 밖으로 삐져나온 자식,
 * 말줄임 없이 잘린 글자, 다른 요소에 덮여 못 누르는 버튼을 볼 수 없고, 다크·고대비 테마는
 * 아예 열지 않는다. 이 점검이 그 넷을 본다.
 *
 * 색약 모드는 레이아웃을 바꾸지 않으므로 행렬에 넣지 않는다 — 팔레트가 실제로 갈리는지는
 * `client/src/theme/accessibility.test.ts`가 고정한다.
 *
 * 검증 스택은 매번 현재 소스로 이미지를 새로 굽기 때문에 옛 번들을 잴 일이 없다.
 */

const ROUTES = ['/', '/login', '/signup', '/reset-password', '/change-password', '/rooms', '/rooms/create', '/rooms/join', '/profile', '/settings', '/how-to-play', '/replay', '/no-such-page'];
const VIEWPORTS = [
    { width: 1920, height: 1080 }, { width: 1280, height: 720 }, { width: 768, height: 1024 },
    { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 640 },
];
const THEMES = [
    { name: 'light', theme: 0, highContrast: false },
    { name: 'dark', theme: 1, highContrast: false },
    { name: 'dark-hc', theme: 1, highContrast: true },
] as const;

interface Probe {
    pageOverflow: number;
    escapes: { el: string; parent: string; px: number }[];
    clipped: { el: string; px: number }[];
    overlaps: { el: string; blockedBy: string }[];
    tiny: { el: string; w: number; h: number }[];
}

/** 브라우저 안에서 돈다. 바깥 변수를 쓸 수 없다. */
function probe(): Probe {
    const label = (el: Element) => {
        const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
        const text = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32);
        return `${el.tagName.toLowerCase()}${cls}${text ? ` «${text}»` : ''}`;
    };
    const visible = (el: Element) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility === 'visible' && Number(cs.opacity) > 0 && r.width > 1 && r.height > 1;
    };
    // 스크린리더 전용 글자는 1px 상자에 일부러 가둔 것이라 잘림으로 세지 않는다.
    const srOnly = (el: Element) => Boolean(el.closest('.visually-hidden, .sr-only')) || getComputedStyle(el).clipPath !== 'none';
    const all = [...document.body.querySelectorAll('*')].filter((el) =>
        !(el instanceof SVGElement) && el.tagName !== 'CANVAS' && !el.closest('[aria-hidden="true"]') && !srOnly(el) && visible(el));

    const out: Probe = { pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, escapes: [], clipped: [], overlaps: [], tiny: [] };

    for (const el of all) {
        // 잘라내는 조상만 본다. overflow: visible인 부모 밖으로 나가는 건 설계된 동작이다.
        let clip: Element | null = null;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const cs = getComputedStyle(p);
            if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { clip = p; break; }
        }
        if (!clip) continue;
        const cs = getComputedStyle(clip);
        const a = el.getBoundingClientRect(), b = clip.getBoundingClientRect();
        const sx = ['auto', 'scroll'].includes(cs.overflowX), sy = ['auto', 'scroll'].includes(cs.overflowY);
        const px = Math.max(sx ? 0 : b.left - a.left, sx ? 0 : a.right - b.right, sy ? 0 : b.top - a.top, sy ? 0 : a.bottom - b.bottom);
        if (px > 3) out.escapes.push({ el: label(el), parent: label(clip), px: Math.round(px) });

        const own = getComputedStyle(el);
        const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
        if (hasText && own.overflowX === 'hidden' && own.textOverflow !== 'ellipsis' && el.scrollWidth - el.clientWidth > 2) {
            out.clipped.push({ el: label(el), px: el.scrollWidth - el.clientWidth });
        }
    }

    const controls = [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="checkbox"]')].filter(visible);
    for (const el of controls) {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
        const top = document.elementFromPoint(cx, cy);
        if (top && top !== el && !el.contains(top) && !top.contains(el)) out.overlaps.push({ el: label(el), blockedBy: label(top) });
        // WCAG 2.5.8(AA)의 최소 표적 24×24.
        if (r.width < 24 || r.height < 24) out.tiny.push({ el: label(el), w: Math.round(r.width), h: Math.round(r.height) });
    }
    return out;
}

async function settle(page: Page) {
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        await Promise.allSettled(document.getAnimations().map((a) => a.finished));
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    });
}

test('every menu screen stays inside its boxes in light, dark and high-contrast themes', async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const dir = resolve('e2e/artifacts/ui-matrix');
    await mkdir(dir, { recursive: true });

    const results: unknown[] = [];
    for (const theme of THEMES) {
        const context = await browser.newContext({ baseURL, viewport: VIEWPORTS[0], locale: 'ko-KR', reducedMotion: 'reduce' });
        await context.addInitScript((state) => localStorage.setItem('switch-settings', JSON.stringify({ version: 2, state })),
            { theme: theme.theme, highContrast: theme.highContrast, masterVolume: 0, bgmEnabled: false, motionLevel: 'reduced' });
        const page = await context.newPage();
        try {
            for (const route of ROUTES) {
                await page.setViewportSize(VIEWPORTS[0]!);
                await page.goto(route);
                await expect(page.locator('h1').first()).toBeAttached({ timeout: 15_000 });
                for (const viewport of VIEWPORTS) {
                    await page.setViewportSize(viewport);
                    await settle(page);
                    const where = `${theme.name} ${route} ${viewport.width}x${viewport.height}`;
                    const found = await page.evaluate(probe);
                    results.push({ where, ...found });
                    expect.soft(found.pageOverflow, `${where}: page scrolls sideways`).toBeLessThanOrEqual(1);
                    expect.soft(found.escapes, `${where}: element escapes a clipping box`).toEqual([]);
                    expect.soft(found.clipped, `${where}: text is cut without an ellipsis`).toEqual([]);
                    expect.soft(found.overlaps, `${where}: control is covered by another element`).toEqual([]);
                    /*
                     * 작은 표적은 실패로 세지 않고 남기기만 한다. 16:9 스테이지를 통째로 축소하는
                     * 화면(태블릿 세로, 가로 폰)에서는 구조상 24px 아래로 내려간다 — 고치려면
                     * 반응형 분기를 넓히는 설계 결정이 먼저다. 숫자는 보고서에서 본다.
                     */
                    if (found.tiny.length) test.info().annotations.push({ type: 'small-target', description: `${where}: ${found.tiny.map((t) => `${t.el} ${t.w}x${t.h}`).join(', ')}` });
                }
            }
        } finally {
            await context.close();
        }
    }
    await writeFile(resolve(dir, 'results.json'), JSON.stringify(results, null, 2));
});
