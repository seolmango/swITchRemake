import type Phaser from 'phaser';

type Point = readonly [number, number];

/**
 * Traces the outer boundary of a set of grid cells (adjacent cells merge into one outline — no internal
 * edges between them) via directed-edge boundary tracing: every grid edge where the cell on one side is
 * in the set and the other isn't becomes a directed unit segment, then segments are chained by matching
 * endpoints into closed loops. With this edge convention, outer boundaries come out clockwise and any
 * enclosed holes come out counter-clockwise "for free" — useful if a region ever wraps around itself,
 * though typical map tile clusters won't produce one.
 *
 * Returns loops in TILE-INDEX space (not px) — scale by TILE_SIZE before drawing.
 */
export function traceRegionOutlines(tiles: readonly (readonly [number, number])[]): Point[][] {
    const set = new Set(tiles.map(([x, y]) => `${x},${y}`));
    const has = (x: number, y: number): boolean => set.has(`${x},${y}`);

    const edgesByStart = new Map<string, Point>();
    for (const [x, y] of tiles) {
        if (!has(x, y - 1)) edgesByStart.set(`${x},${y}`, [x + 1, y]);
        if (!has(x + 1, y)) edgesByStart.set(`${x + 1},${y}`, [x + 1, y + 1]);
        if (!has(x, y + 1)) edgesByStart.set(`${x + 1},${y + 1}`, [x, y + 1]);
        if (!has(x - 1, y)) edgesByStart.set(`${x},${y + 1}`, [x, y]);
    }

    const loops: Point[][] = [];
    const consumed = new Set<string>();
    for (const startKey of edgesByStart.keys()) {
        if (consumed.has(startKey)) continue;
        const loop: Point[] = [];
        let key = startKey;
        do {
            consumed.add(key);
            const parts = key.split(',');
            loop.push([Number(parts[0]), Number(parts[1])]);
            const next = edgesByStart.get(key);
            if (!next) break;
            key = `${next[0]},${next[1]}`;
        } while (key !== startKey);
        if (loop.length >= 3) loops.push(simplifyCollinear(loop));
    }
    return loops;
}

/** Drops vertices where the loop just passes straight through (incoming/outgoing edge collinear) — a
 * long straight run of unit tile-edges otherwise leaves redundant 0°-turn vertices in the path for no
 * benefit (each is a plain lineTo, not a real corner). Turned out not to be the cause of a stroke
 * rendering bug investigated alongside this (see MapLayer.redrawSmoke's first-cycle-after-clear note),
 * but it's a legitimate simplification on its own, so it stays. */
function simplifyCollinear(loop: Point[]): Point[] {
    const n = loop.length;
    if (n < 3) return loop;
    const out: Point[] = [];
    for (let i = 0; i < n; i++) {
        const prev = loop[(i - 1 + n) % n]!;
        const cur = loop[i]!;
        const next = loop[(i + 1) % n]!;
        const d1 = dirOf(prev, cur), d2 = dirOf(cur, next);
        const cross = d1[0] * d2[1] - d1[1] * d2[0];
        const dot = d1[0] * d2[0] + d1[1] * d2[1];
        const isStraightThrough = Math.abs(cross) < 1e-9 && dot > 0;
        if (!isStraightThrough) out.push(cur);
    }
    return out.length >= 3 ? out : loop;
}

const dirOf = (a: Point, b: Point): Point => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
};

/**
 * Appends one closed loop of an axis-aligned (orthogonal) polygon to the graphics' current path,
 * rounding convex (outward) corners with `radius` and leaving concave (reflex) corners sharp. Every
 * edge here is guaranteed horizontal or vertical (loops come from `traceRegionOutlines`), which is what
 * makes the corner-cut-and-arc construction exact instead of an approximation.
 */
export function traceOrthogonalRoundedLoop(g: Phaser.GameObjects.Graphics, pts: readonly Point[], radius: number): void {
    const n = pts.length;
    if (n < 3) return;
    const dirs: Point[] = pts.map((p, i) => dirOf(p, pts[(i + 1) % n]!));

    const incoming0 = dirs[n - 1]!, outgoing0 = dirs[0]!;
    const p0 = pts[0]!;
    const cross0 = incoming0[0] * outgoing0[1] - incoming0[1] * outgoing0[0];
    if (cross0 > 0) {
        g.moveTo(p0[0] - incoming0[0] * radius, p0[1] - incoming0[1] * radius);
    } else {
        g.moveTo(p0[0], p0[1]);
    }

    for (let i = 0; i < n; i++) {
        const incoming = dirs[(i - 1 + n) % n]!;
        const outgoing = dirs[i]!;
        const v = pts[i]!;
        const cross = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
        if (cross > 0) {
            const pa: Point = [v[0] - incoming[0] * radius, v[1] - incoming[1] * radius];
            const pb: Point = [v[0] + outgoing[0] * radius, v[1] + outgoing[1] * radius];
            const center: Point = [pa[0] + outgoing[0] * radius, pa[1] + outgoing[1] * radius];
            g.lineTo(pa[0], pa[1]);
            const a0 = Math.atan2(pa[1] - center[1], pa[0] - center[0]);
            const a1 = Math.atan2(pb[1] - center[1], pb[0] - center[0]);
            g.arc(center[0], center[1], radius, a0, a1, false);
        } else {
            g.lineTo(v[0], v[1]);
        }
    }
    g.closePath();
}
