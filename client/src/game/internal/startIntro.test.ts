import { describe, expect, it } from 'vitest';
import { START_INTRO, blendIntroCamera, startIntroProgress } from './startIntro.ts';

describe('start intro timeline', () => {
    const endsAt = 10_000;
    const { HOLD_MS, TRAVEL_MS, REDUCED_CUT_MS } = START_INTRO;

    it('leaves time to read the whole map after a slow page load', () => {
        // 서버 카운트다운 9초 중 화면 준비가 2초를 먹어도 전체 맵을 1초 이상 비춘다.
        expect(HOLD_MS + TRAVEL_MS).toBeLessThanOrEqual(9000 - 2000 - 1000);
        expect(startIntroProgress(endsAt - 6000, endsAt, false)).toBe(0);
    });

    it('shows the whole map, travels, then holds at play zoom until the start', () => {
        expect(startIntroProgress(endsAt - HOLD_MS - TRAVEL_MS, endsAt, false)).toBe(0);
        const mid = startIntroProgress(endsAt - HOLD_MS - TRAVEL_MS / 2, endsAt, false);
        expect(mid).toBeGreaterThan(0.4);
        expect(mid).toBeLessThan(0.6);
        expect(startIntroProgress(endsAt - HOLD_MS, endsAt, false)).toBe(1);
        expect(startIntroProgress(endsAt, endsAt, false)).toBe(1);
        // 첫 스냅샷이 늦게 와도 내 자리에 머문다.
        expect(startIntroProgress(endsAt + 500, endsAt, false)).toBe(1);
    });

    it('never moves backwards, so a late joiner just starts further along', () => {
        let previous = 0;
        for (let now = endsAt - 8000; now <= endsAt; now += 50) {
            const progress = startIntroProgress(now, endsAt, false);
            expect(progress).toBeGreaterThanOrEqual(previous);
            previous = progress;
        }
    });

    it('reduced motion cuts between two still shots instead of moving', () => {
        for (let now = endsAt - 8000; now <= endsAt; now += 50) {
            expect([0, 1]).toContain(startIntroProgress(now, endsAt, true));
        }
        expect(startIntroProgress(endsAt - REDUCED_CUT_MS - 1, endsAt, true)).toBe(0);
        expect(startIntroProgress(endsAt - REDUCED_CUT_MS, endsAt, true)).toBe(1);
    });

    it('blends position linearly and zoom geometrically, landing exactly on both ends', () => {
        const from = { x: 0, y: 0, zoom: 0.1 };
        const to = { x: 1000, y: 500, zoom: 1 };
        const start = blendIntroCamera(from, to, 0);
        expect(start.x).toBe(0);
        expect(start.y).toBe(0);
        expect(start.zoom).toBeCloseTo(0.1, 10);
        const end = blendIntroCamera(from, to, 1);
        expect(end.x).toBe(1000);
        expect(end.y).toBe(500);
        expect(end.zoom).toBeCloseTo(1, 10);
        expect(blendIntroCamera(from, to, 0.5).zoom).toBeCloseTo(Math.sqrt(0.1), 10);
    });
});
