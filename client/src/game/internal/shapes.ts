import Phaser from 'phaser';

/**
 * Traces a rounded-rect as a subpath without closing/filling. Call between
 * `graphics.beginPath()` and `graphics.fillPath()/strokePath()`. Several
 * overlapping calls inside one begin/fill pair merge into a single blob
 * under the nonzero winding rule — used to draw grass/smoke tile clusters
 * as one rounded shape instead of a grid of separate rounded tiles.
 *
 * Phaser's Graphics has no `arcTo`, so this reimplements a rounded rect from
 * `lineTo` + `arc` quarter turns (canvas's arcTo-based path, in Phaser terms).
 */
export function traceRoundedRect(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, radius: number): void {
    const r = Math.min(radius, w / 2, h / 2);
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.arc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
    g.lineTo(x + w, y + h - r);
    g.arc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
    g.lineTo(x + r, y + h);
    g.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
    g.lineTo(x, y + r);
    g.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
    g.closePath();
}

/** Phaser's Graphics path builder has no quadraticCurveTo — approximate with a short polyline. */
export function traceQuadraticCurve(g: Phaser.GameObjects.Graphics, x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, segments = 6): void {
    g.moveTo(x0, y0);
    for (let i = 1; i <= segments; i++) {
        const t = i / segments;
        const mt = 1 - t;
        const x = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
        const y = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
        g.lineTo(x, y);
    }
}

export function fillRoundedRect(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, r: number, color: number, alpha: number): void {
    if (w <= 0 || h <= 0) return;
    g.fillStyle(color, alpha);
    g.beginPath();
    traceRoundedRect(g, x, y, w, h, r);
    g.fillPath();
}

export function strokeRoundedRect(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, r: number, color: number, alpha: number, lineWidth: number): void {
    if (w <= 0 || h <= 0) return;
    g.lineStyle(lineWidth, color, alpha);
    g.beginPath();
    traceRoundedRect(g, x, y, w, h, r);
    g.strokePath();
}

// `traceTileBlob` used to live here: per-tile rounded rects pushed into one path so the fill unioned
// them. Removed once grass moved to real boundary tracing (`regionOutline.ts`) — the union only ever
// worked for fills, since `strokePath` outlines every subpath, internal edges included.
