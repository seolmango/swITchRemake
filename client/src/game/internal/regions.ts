import { TilePhysics, type MapView, type RegionInfo } from '../types.ts';
import { TILE_SIZE } from '../constants.ts';

const NEIGHBORS_8 = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [-1, -1], [1, -1], [-1, 1],
] as const;

/** All tiles of a given physics value, unordered — used for the (single, non-addressable) bush blob. */
export function collectTiles(map: MapView, physics: TilePhysics): [number, number][] {
    const out: [number, number][] = [];
    for (let y = 0; y < map.rows; y++) {
        const row = map.tiles[y];
        if (!row) continue;
        for (let x = 0; x < map.cols; x++) {
            if (row[x] === physics) out.push([x, y]);
        }
    }
    return out;
}

/**
 * 8-directionally connected components of `physics`-matching tiles, each becoming an
 * individually addressable region (used for gas/smoke, which can dissipate per-cluster).
 */
export function buildRegions(map: MapView, physics: typeof TilePhysics.Bush | typeof TilePhysics.Gas): RegionInfo[] {
    const seen = new Set<string>();
    const regions: RegionInfo[] = [];

    const at = (x: number, y: number): TilePhysics | undefined => map.tiles[y]?.[x];

    for (let y = 0; y < map.rows; y++) {
        for (let x = 0; x < map.cols; x++) {
            const key = `${x},${y}`;
            if (at(x, y) !== physics || seen.has(key)) continue;

            const tiles: [number, number][] = [];
            const stack: [number, number][] = [[x, y]];
            seen.add(key);
            while (stack.length > 0) {
                const [cx, cy] = stack.pop()!;
                tiles.push([cx, cy]);
                for (const [dx, dy] of NEIGHBORS_8) {
                    const nx = cx + dx, ny = cy + dy;
                    const nk = `${nx},${ny}`;
                    if (at(nx, ny) === physics && !seen.has(nk)) {
                        seen.add(nk);
                        stack.push([nx, ny]);
                    }
                }
            }

            const mx = tiles.reduce((sum, t) => sum + t[0], 0) / tiles.length;
            const my = tiles.reduce((sum, t) => sum + t[1], 0) / tiles.length;
            regions.push({
                id: `${physics}:${x},${y}`,
                physics,
                tiles,
                centerX: (mx + 0.5) * TILE_SIZE,
                centerY: (my + 0.5) * TILE_SIZE,
            });
        }
    }

    return regions;
}
