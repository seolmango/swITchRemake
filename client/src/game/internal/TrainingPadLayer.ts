// 타입으로만 불러야 Node 테스트가 Phaser의 DOM 초기화를 실행하지 않는다.
import type Phaser from 'phaser';
import { TrainingPadKind, type TrainingPad } from 'shared';
import { Palette } from '../palette.ts';
import type { Theme } from '../types.ts';
import { TRAINING_PAD_TEXTURE } from '../trainingPadTextures.ts';
import { DEPTH } from './depth.ts';

const PAD_COLOR: Record<TrainingPadKind, () => number> = {
    [TrainingPadKind.Tagger]: () => Palette.red[2],
    [TrainingPadKind.SkillDash]: () => Palette.blue[2],
    [TrainingPadKind.SkillFlash]: () => Palette.user[5]![1],
    [TrainingPadKind.SkillExhaust]: () => Palette.grass[2],
    [TrainingPadKind.Reset]: () => Palette.gray[2],
    // 추격 모드는 역할을 뒤집는 자리라 술래와 같은 붉은 계열로 묶는다.
    [TrainingPadKind.ChaseMode]: () => Palette.red[1],
};

const SKILL_TEXTURE: Partial<Record<TrainingPadKind, string>> = {
    [TrainingPadKind.SkillDash]: TRAINING_PAD_TEXTURE.dash,
    [TrainingPadKind.SkillFlash]: TRAINING_PAD_TEXTURE.flash,
    [TrainingPadKind.SkillExhaust]: TRAINING_PAD_TEXTURE.exhaust,
};

export class TrainingPadLayer {
    private readonly scene: Phaser.Scene;
    private readonly gfx: Phaser.GameObjects.Graphics;
    private icons: Phaser.GameObjects.Image[] = [];
    private pads: readonly TrainingPad[] = [];
    private theme: Theme;

    constructor(scene: Phaser.Scene, theme: Theme) {
        this.scene = scene;
        this.theme = theme;
        this.gfx = scene.add.graphics().setDepth(DEPTH.trainingPad);
    }

    setPads(pads: readonly TrainingPad[]): void {
        this.pads = pads.map((pad) => ({ ...pad }));
        this.redraw();
    }

    setTheme(theme: Theme): void {
        this.theme = theme;
        this.redraw();
    }

    private redraw(): void {
        this.gfx.clear();
        for (const icon of this.icons) icon.destroy();
        this.icons = [];

        for (const pad of this.pads) {
            const color = PAD_COLOR[pad.kind]();
            this.gfx.fillStyle(color, this.theme === 0 ? 0.28 : 0.18);
            this.gfx.fillCircle(pad.x, pad.y, pad.radius);
            this.gfx.lineStyle(Math.max(5, pad.radius * 0.045), color, 0.95);
            this.gfx.strokeCircle(pad.x, pad.y, pad.radius);

            const texture = SKILL_TEXTURE[pad.kind];
            if (texture) {
                const size = pad.radius * 0.92;
                this.icons.push(this.scene.add.image(pad.x, pad.y, texture)
                    .setDisplaySize(size, size)
                    .setDepth(DEPTH.trainingPadIcon)
                    .setAlpha(this.theme === 0 ? 0.9 : 1));
            } else if (pad.kind === TrainingPadKind.Tagger) {
                this.drawTaggerIcon(pad, color);
            } else {
                this.drawResetIcon(pad, color);
            }
        }
    }

    private drawTaggerIcon(pad: TrainingPad, color: number): void {
        const r = pad.radius;
        this.gfx.lineStyle(Math.max(6, r * 0.055), color, 1);
        this.gfx.beginPath();
        this.gfx.moveTo(pad.x - r * 0.22, pad.y + r * 0.3);
        this.gfx.lineTo(pad.x - r * 0.22, pad.y - r * 0.34);
        this.gfx.lineTo(pad.x + r * 0.3, pad.y - r * 0.18);
        this.gfx.lineTo(pad.x - r * 0.22, pad.y);
        this.gfx.strokePath();
    }

    private drawResetIcon(pad: TrainingPad, color: number): void {
        const r = pad.radius;
        this.gfx.lineStyle(Math.max(6, r * 0.055), color, 1);
        this.gfx.beginPath();
        this.gfx.arc(pad.x, pad.y, r * 0.3, -Math.PI * 0.75, Math.PI * 1.25, false);
        this.gfx.strokePath();
        this.gfx.fillStyle(color, 1);
        this.gfx.fillTriangle(
            pad.x - r * 0.34, pad.y - r * 0.28,
            pad.x - r * 0.03, pad.y - r * 0.3,
            pad.x - r * 0.25, pad.y - r * 0.04,
        );
    }

    destroy(): void {
        this.gfx.destroy();
        for (const icon of this.icons) icon.destroy();
        this.icons = [];
    }
}
