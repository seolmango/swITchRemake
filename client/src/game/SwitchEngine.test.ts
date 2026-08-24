import { describe, expect, it } from 'vitest';
import { phaserFpsLimit } from './internal/frameRateLimit.ts';

describe('Phaser frame limiter selection', () => {
    it('keeps only the explicit low-power limit', () => {
        expect(phaserFpsLimit(30)).toBe(30);
        expect(phaserFpsLimit(60)).toBe(0);
        expect(phaserFpsLimit(120)).toBe(0);
        expect(phaserFpsLimit(0)).toBe(0);
    });
});
