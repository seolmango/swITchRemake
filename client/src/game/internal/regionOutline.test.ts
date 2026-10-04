import { describe, expect, it } from 'vitest';
import { traceRegionOutlines } from './regionOutline.ts';

type Point = readonly [number, number];
const area = (loop: readonly Point[]): number => loop.reduce((sum, [x, y], index) => {
    const [nx, ny] = loop[(index + 1) % loop.length]!;
    return sum + x * ny - nx * y;
}, 0) / 2;
const perimeter = (loop: readonly Point[]): number => loop.reduce((sum, [x, y], index) => {
    const [nx, ny] = loop[(index + 1) % loop.length]!;
    return sum + Math.abs(nx - x) + Math.abs(ny - y);
}, 0);

describe('tile region outlines', () => {
    it('traces separate closed silhouettes at a diagonal junction instead of looping forever', () => {
        const loops = traceRegionOutlines([[0, 0], [1, 1]]);
        expect(loops).toHaveLength(2);
        expect(loops.map(area)).toEqual([1, 1]);
        expect(loops.map(perimeter)).toEqual([4, 4]);
    });

    it('keeps the shape and hole after tiles are culled or split into alpha batches', () => {
        const tiles: Point[] = [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]];
        expect(traceRegionOutlines(tiles).map(area).sort((a, b) => a - b)).toEqual([-1, 9]);
        const visible = tiles.filter(([x, y]) => x > 0 || y > 0);
        expect(traceRegionOutlines(visible).reduce((sum, loop) => sum + area(loop), 0)).toBe(7);
        const alphaBatch = visible.filter(([x, y]) => (x + y) % 2 === 0);
        expect(traceRegionOutlines(alphaBatch).reduce((sum, loop) => sum + area(loop), 0)).toBe(alphaBatch.length);
    });

    it('preserves every boundary edge and signed area for all 3 by 3 tile arrangements', () => {
        for (let mask = 0; mask < 512; mask++) {
            const tiles: Point[] = [];
            for (let cell = 0; cell < 9; cell++) if (mask & (1 << cell)) tiles.push([cell % 3, Math.floor(cell / 3)]);
            const set = new Set(tiles.map(([x, y]) => `${x},${y}`));
            const boundary = tiles.reduce((sum, [x, y]) => sum
                + [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => !set.has(`${x + dx!},${y + dy!}`)).length, 0);
            const loops = traceRegionOutlines(tiles);
            expect(loops.reduce((sum, loop) => sum + area(loop), 0), `area for tile mask ${mask}`).toBe(tiles.length);
            expect(loops.reduce((sum, loop) => sum + perimeter(loop), 0), `boundary for tile mask ${mask}`).toBe(boundary);
        }
    });

    it('ignores duplicate cells without duplicating their boundary', () => {
        expect(traceRegionOutlines([[0, 0], [0, 0]]).map(area)).toEqual([1]);
    });
});
