import { describe, expect, it } from 'vitest';
import { cameraFollowLerp } from './cameraSmoothing.ts';

function simulate(options: { roundPixels: boolean; halfLifeMs: number; frames: number; warmupFrames: number }) {
    const frameMs = 1_000 / 60;
    const speedPxPerSecond = 100;
    let target = 0;
    let scroll = 0;
    const changes: number[] = [];

    for (let frame = 0; frame < options.frames + options.warmupFrames; frame += 1) {
        target += speedPxPerSecond * frameMs / 1_000;
        const lerp = cameraFollowLerp(frameMs, options.halfLifeMs);
        const next = scroll + (target - scroll) * lerp;
        const rendered = options.roundPixels ? Math.floor(next) : next;
        if (frame >= options.warmupFrames) changes.push(rendered - scroll);
        scroll = rendered;
    }

    const mean = changes.reduce((sum, value) => sum + value, 0) / changes.length;
    const variance = changes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / changes.length;
    return { changes, variance };
}

describe('camera smoothing', () => {
    it('has the same response over equal elapsed time at different frame rates', () => {
        const after = (fps: number) => {
            let remaining = 1;
            const deltaMs = 1_000 / fps;
            for (let frame = 0; frame < fps; frame += 1) {
                remaining *= 1 - cameraFollowLerp(deltaMs, 40);
            }
            return remaining;
        };

        expect(after(30)).toBeCloseTo(after(60), 12);
        expect(after(60)).toBeCloseTo(after(120), 12);
    });

    it('removes integer-stepped camera motion during constant-speed travel', () => {
        const before = simulate({ roundPixels: true, halfLifeMs: 71.1, frames: 60, warmupFrames: 240 });
        const after = simulate({ roundPixels: false, halfLifeMs: 40, frames: 60, warmupFrames: 240 });

        expect(new Set(before.changes).size).toBeGreaterThan(1);
        expect(before.variance).toBeGreaterThan(0.1);
        expect(after.variance).toBeLessThan(1e-20);
    });
});
