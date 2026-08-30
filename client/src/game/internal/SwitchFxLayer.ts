// 타입으로만 쓴다. 값으로 import하면 Phaser의 device 탐지가 돌면서 테스트 환경(node)에서 죽는다.
import type Phaser from 'phaser';
import { Palette } from '../palette.ts';
import { SWITCH_FX, type RenderOptions } from '../constants.ts';
import type { Theme } from '../types.ts';
import { DEPTH } from './depth.ts';

interface SwitchEntry {
    x: number;
    y: number;
    radius: number;
    /** 지목한 상대의 팔레트 index. 시전자가 아니라 **대상**의 색이라는 게 이 연출의 요점이다. */
    colorIndex: number;
    bornAt: number;
}

/**
 * 스위치를 시도한 자리에 사거리만큼의 원을 남긴다. 레거시의 연출을 그대로 옮겼다
 * (이전 React 클라이언트 `Engine.js`의 skill.type 1~8 분기).
 *
 * 색이 대상에게서 오는 것이 핵심이다. 주변 사람은 "누가 누구를 노렸는지"를 색으로 읽는다.
 * 시전자 색으로 칠하면 그 정보가 사라진다.
 *
 * 수명은 blink와 같은 이유로 이 레이어가 직접 잰다 — 게임 상태가 아니라 던져 놓고 잊는 연출이다.
 */
export class SwitchFxLayer {
    private readonly gfx: Phaser.GameObjects.Graphics;
    private entries: SwitchEntry[] = [];

    constructor(scene: Phaser.Scene) {
        this.gfx = scene.add.graphics().setDepth(DEPTH.switchFx);
    }

    play(x: number, y: number, radius: number, colorIndex: number, now: number): void {
        this.entries.push({ x, y, radius, colorIndex, bornAt: now });
    }

    update(now: number, theme: Theme, opts: RenderOptions): void {
        this.entries = this.entries.filter((e) => now - e.bornAt < SWITCH_FX.life);
        const g = this.gfx;
        g.clear();
        for (const e of this.entries) {
            const k = (now - e.bornAt) / SWITCH_FX.life;
            // 섬광 줄이기에서는 처음부터 옅게 시작한다. 사라지는 것 자체는 남겨야 "시도했다"가 읽힌다.
            const peak = opts.reduceFlash ? SWITCH_FX.reducedAlpha : SWITCH_FX.alpha;
            const [fill, stroke] = Palette.user[e.colorIndex] ?? Palette.user[0]!;

            g.fillStyle(fill, peak * (1 - k));
            g.fillCircle(e.x, e.y, e.radius);
            g.lineStyle(SWITCH_FX.lineWidth, theme === 1 ? Palette.white : stroke, peak * (1 - k) * 1.4);
            g.strokeCircle(e.x, e.y, e.radius);
        }
    }

    destroy(): void {
        this.gfx.destroy();
    }
}
