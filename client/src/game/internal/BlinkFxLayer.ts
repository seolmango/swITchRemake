import Phaser from 'phaser';
import { Palette } from '../palette.ts';
import { BLINK_FX, type RenderOptions } from '../constants.ts';
import type { Theme } from '../types.ts';
import { strokeDashedLine } from './dashed.ts';
import { DEPTH } from './PlayerSprite.ts';

interface BlinkEntry {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    colorIndex: number;
    bornAt: number;
}

/** Owns the fade-out timer itself — a blink trail is a fire-and-forget cosmetic VFX, not gameplay state. */
export class BlinkFxLayer {
    private readonly gfx: Phaser.GameObjects.Graphics;
    private entries: BlinkEntry[] = [];

    constructor(scene: Phaser.Scene) {
        this.gfx = scene.add.graphics().setDepth(DEPTH.blinkFx);
    }

    play(x0: number, y0: number, x1: number, y1: number, colorIndex: number, now: number): void {
        this.entries.push({ x0, y0, x1, y1, colorIndex, bornAt: now });
    }

    /**
     * `now`는 실제 시계(수명), `t`는 모션 설정이 반영된 애니메이션 시계(점선 흐름)다. 모션을 끄면
     * 궤적이 흐르지 않을 뿐, 궤적이 화면에 영구히 박히지는 않는다.
     */
    update(now: number, t: number, theme: Theme, opts: RenderOptions): void {
        this.entries = this.entries.filter((e) => now - e.bornAt < BLINK_FX.life);
        const g = this.gfx;
        g.clear();
        for (const e of this.entries) {
            const k = (now - e.bornAt) / BLINK_FX.life;
            const fadeAlpha = 1 - k;
            const [fill] = Palette.user[e.colorIndex] ?? Palette.user[0]!;

            g.lineStyle(BLINK_FX.lineWidth, theme === 1 ? Palette.white : Palette.black, fadeAlpha * 0.55);
            if (opts.quality.dashedLines) {
                strokeDashedLine(g, e.x0, e.y0, e.x1, e.y1, BLINK_FX.dash[0], BLINK_FX.dash[1], -t * 30);
            } else {
                g.beginPath();
                g.moveTo(e.x0, e.y0);
                g.lineTo(e.x1, e.y1);
                g.strokePath();
            }

            g.fillStyle(fill, fadeAlpha * 0.7);
            g.fillCircle(e.x0, e.y0, BLINK_FX.startRadius);

            g.lineStyle(BLINK_FX.ringLineWidth, theme === 1 ? Palette.white : Palette.black, fadeAlpha);
            g.strokeCircle(e.x0, e.y0, BLINK_FX.startRadius + k * BLINK_FX.ringGrow);
            g.strokeCircle(e.x1, e.y1, BLINK_FX.startRadius + (1 - k) * BLINK_FX.ringGrow);
        }
    }

    destroy(): void {
        this.gfx.destroy();
    }
}
