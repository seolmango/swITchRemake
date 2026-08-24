import { describe, expect, it } from 'vitest';
import {
    advanceRenderTick,
    bufferEntityPositions,
    interpolateEntityPosition,
    RENDER_TICK_MAX_DELTA_MS,
    type EntityPositionBuffers,
} from './entityInterpolation.ts';

const MAX_DISTANCE = 3 * 256;

function add(
    previous: EntityPositionBuffers,
    tick: number,
    positions: readonly { id: number; x: number; y: number }[],
    forceSnapIds?: ReadonlySet<number>,
) {
    return bufferEntityPositions(previous, tick, positions, {
        maxInterpolationDistance: MAX_DISTANCE,
        ...(forceSnapIds === undefined ? {} : { forceSnapIds }),
    });
}

describe('entity interpolation', () => {
    it('returns the exact midpoint between two snapshots', () => {
        const first = add(new Map(), 100, [{ id: 1, x: 10, y: 20 }]);
        const second = add(first.buffers, 102, [{ id: 1, x: 30, y: 60 }]);

        expect(interpolateEntityPosition(second.buffers.get(1)!, 101)).toEqual({ x: 20, y: 40 });
    });

    it('holds a single buffered position instead of extrapolating', () => {
        const buffered = add(new Map(), 100, [{ id: 1, x: 10, y: 20 }]);

        expect(interpolateEntityPosition(buffered.buffers.get(1)!, 1_000)).toEqual({ x: 10, y: 20 });
    });

    it('snaps a jump of several tiles instead of interpolating it', () => {
        const first = add(new Map(), 100, [{ id: 1, x: 0, y: 0 }]);
        const second = add(first.buffers, 102, [{ id: 1, x: MAX_DISTANCE, y: 0 }]);

        expect(second.snappedIds.has(1)).toBe(true);
        expect(second.buffers.get(1)).toEqual([{ tick: 102, x: MAX_DISTANCE, y: 0 }]);
        expect(interpolateEntityPosition(second.buffers.get(1)!, 101)).toEqual({ x: MAX_DISTANCE, y: 0 });
    });

    it('snaps the next sample when an authoritative blink event marks the player', () => {
        const first = add(new Map(), 100, [{ id: 1, x: 0, y: 0 }]);
        const blink = add(first.buffers, 102, [{ id: 1, x: 100, y: 0 }], new Set([1]));

        expect(blink.snappedIds.has(1)).toBe(true);
        expect(interpolateEntityPosition(blink.buffers.get(1)!, 101)).toEqual({ x: 100, y: 0 });
    });

    it('drops buffers for players absent from the authoritative section', () => {
        const first = add(new Map(), 100, [
            { id: 1, x: 0, y: 0 },
            { id: 2, x: 10, y: 10 },
        ]);
        const second = add(first.buffers, 102, [{ id: 1, x: 5, y: 0 }]);

        expect(second.buffers.has(1)).toBe(true);
        expect(second.buffers.has(2)).toBe(false);
    });

    it('uses tick distance when an intermediate snapshot is lost', () => {
        const first = add(new Map(), 100, [{ id: 1, x: 0, y: 0 }]);
        const afterLoss = add(first.buffers, 104, [{ id: 1, x: 40, y: 20 }]);

        expect(interpolateEntityPosition(afterLoss.buffers.get(1)!, 102)).toEqual({ x: 20, y: 10 });
    });

    it('smoothly pulls a clock ahead of the target back toward it', () => {
        const target = 101;
        const advanced = advanceRenderTick(101, 103, 1000 / 60, 60);

        expect(advanced).toBeLessThan(target + 1);
        expect(advanced).toBeGreaterThan(target);
    });

    it('smoothly pulls a clock behind the target forward toward it', () => {
        const target = 101;
        const advanced = advanceRenderTick(99, 103, 1000 / 60, 60);

        expect(advanced).toBeGreaterThan(target - 1);
        expect(advanced).toBeLessThan(target);
    });

    it('hard-resets a background-resume-sized clock error to the delayed target', () => {
        expect(advanceRenderTick(0, 102, 1000 / 60, 60)).toBe(100);
    });

    it('caps a large frame delta before advancing the clock', () => {
        const target = 100;
        expect(advanceRenderTick(target, 102, 5_000, 60)).toBe(
            advanceRenderTick(target, 102, RENDER_TICK_MAX_DELTA_MS, 60),
        );
    });

    it('leaves normal playback unchanged when the predicted clock meets the target', () => {
        expect(advanceRenderTick(100, 103, 1000 / 60, 60)).toBeCloseTo(101, 10);
    });

    it.each([1, 1.01, 0.99])('keeps the clock bounded over five minutes at a %s frame-rate multiplier', (multiplier) => {
        const simulationHz = 30;
        const frameMs = (1_000 / 60) * multiplier;
        const frames = 5 * 60 * 60;
        let renderTick: number | null = null;
        let largestError = 0;

        for (let frame = 0; frame < frames; frame += 1) {
            const serverTick = Math.floor((frame + 1) / 2);
            renderTick = advanceRenderTick(renderTick, serverTick, frameMs, simulationHz);
            const target = serverTick - 1;
            largestError = Math.max(largestError, Math.abs(renderTick - target));
        }

        expect(largestError).toBeLessThan(1);
        expect(Math.abs(renderTick! - (Math.floor(frames / 2) - 1))).toBeLessThan(1);
    });
});
