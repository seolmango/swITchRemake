// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { contentViewport, overlayRoot, setRotated, toContentDelta } from './forcedLandscape.ts';

describe('forced landscape', () => {
    afterEach(() => setRotated(false));

    it('leaves input and size untouched when the screen is not rotated', () => {
        expect(toContentDelta(3, 4)).toEqual({ x: 3, y: 4 });
        expect(contentViewport(390, 844)).toEqual({ width: 390, height: 844 });
        expect(overlayRoot()).toBe(document.body);
    });

    it('maps a downward finger move to rightward inside the rotated stage', () => {
        setRotated(true);
        // 시계 방향 90°: 화면 아래 = 안의 오른쪽, 화면 오른쪽 = 안의 위.
        expect(toContentDelta(0, 10)).toEqual({ x: 10, y: -0 });
        expect(toContentDelta(10, 0)).toEqual({ x: 0, y: -10 });
        expect(contentViewport(390, 844)).toEqual({ width: 844, height: 390 });
    });

    it('portals touch controls into a layer that carries the same rotation, and removes it after', () => {
        setRotated(true);
        const layer = overlayRoot();
        expect(layer).not.toBe(document.body);
        expect(layer.style.transform).toBe('rotate(90deg)');
        expect(layer.isConnected).toBe(true);
        setRotated(false);
        expect(layer.isConnected).toBe(false);
    });
});
