import Phaser from 'phaser';

/** Phaser's Graphics has no `setLineDash` — these approximate it by stroking short arc/line segments. */

export function strokeDashedCircle(g: Phaser.GameObjects.Graphics, cx: number, cy: number, r: number, dash: number, gap: number, phase: number): void {
    if (r <= 0) return;
    const circumference = 2 * Math.PI * r;
    const period = dash + gap;
    const offset = ((phase % period) + period) % period;
    g.beginPath();
    for (let s = -offset; s < circumference; s += period) {
        const a0 = Math.max(s, 0) / r;
        const a1 = Math.min(s + dash, circumference) / r;
        if (a1 > a0) {
            g.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
            g.arc(cx, cy, r, a0, a1, false);
        }
    }
    g.strokePath();
}

export function strokeDashedLine(g: Phaser.GameObjects.Graphics, x0: number, y0: number, x1: number, y1: number, dash: number, gap: number, phase: number): void {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len <= 0) return;
    const ux = dx / len, uy = dy / len;
    const period = dash + gap;
    const offset = ((phase % period) + period) % period;
    g.beginPath();
    for (let s = -offset; s < len; s += period) {
        const a = Math.max(s, 0);
        const b = Math.min(s + dash, len);
        if (b > a) {
            g.moveTo(x0 + ux * a, y0 + uy * a);
            g.lineTo(x0 + ux * b, y0 + uy * b);
        }
    }
    g.strokePath();
}
