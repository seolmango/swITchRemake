import { describe, expect, it } from 'vitest';
import { SwitchFxLayer } from './SwitchFxLayer.ts';
import { SWITCH_FX } from '../constants.ts';
import { Palette } from '../palette.ts';
import { MOTION_PRESETS, QUALITY_PRESETS, type RenderOptions } from '../constants.ts';
import { DEFAULT_DISPLAY_OPTIONS, DEFAULT_ENGINE_SETTINGS } from '../types.ts';

const DEFAULT_RENDER_OPTIONS: RenderOptions = {
    motion: MOTION_PRESETS[DEFAULT_ENGINE_SETTINGS.motion],
    quality: QUALITY_PRESETS[DEFAULT_ENGINE_SETTINGS.quality],
    reduceFlash: false,
    display: { ...DEFAULT_DISPLAY_OPTIONS },
};

interface Call { fn: string; args: number[] }

/** Phaser Graphics 대신 호출만 받아 적는다. 실제 Phaser는 WebGL이 필요해 jsdom에서 못 돈다. */
function fakeScene() {
    const calls: Call[] = [];
    const gfx = {
        setDepth: () => gfx,
        clear: () => { calls.push({ fn: 'clear', args: [] }); },
        fillStyle: (color: number, alpha: number) => { calls.push({ fn: 'fillStyle', args: [color, alpha] }); },
        fillCircle: (x: number, y: number, r: number) => { calls.push({ fn: 'fillCircle', args: [x, y, r] }); },
        lineStyle: (w: number, color: number, alpha: number) => { calls.push({ fn: 'lineStyle', args: [w, color, alpha] }); },
        strokeCircle: (x: number, y: number, r: number) => { calls.push({ fn: 'strokeCircle', args: [x, y, r] }); },
        destroy: () => {},
    };
    return { scene: { add: { graphics: () => gfx } }, calls };
}

describe('switch attempt effect', () => {
    it('draws the circle at the cast position with the *target* colour', () => {
        const { scene, calls } = fakeScene();
        const layer = new SwitchFxLayer(scene as never);
        // playerId 3을 지목했다면 colorIndex는 2다(playerId는 1부터, 팔레트는 0부터).
        layer.play(120, 340, 90, 2, 0);
        layer.update(0, 0, DEFAULT_RENDER_OPTIONS);

        const fill = calls.find((c) => c.fn === 'fillCircle');
        expect(fill?.args).toEqual([120, 340, 90]);
        const colour = calls.find((c) => c.fn === 'fillStyle');
        expect(colour?.args[0]).toBe(Palette.user[2]![0]);
    });

    it('fades to nothing and stops drawing once it expires', () => {
        const { scene, calls } = fakeScene();
        const layer = new SwitchFxLayer(scene as never);
        layer.play(0, 0, 50, 0, 0);

        layer.update(0, 0, DEFAULT_RENDER_OPTIONS);
        const first = calls.find((c) => c.fn === 'fillStyle')!.args[1]!;
        calls.length = 0;

        layer.update(SWITCH_FX.life * 0.5, 0, DEFAULT_RENDER_OPTIONS);
        const half = calls.find((c) => c.fn === 'fillStyle')!.args[1]!;
        expect(half).toBeLessThan(first);
        calls.length = 0;

        // 수명이 지나면 아예 사라진다. 원이 화면에 박혀 남으면 "누가 여기서 뭘 했다"가 영구 정보가 된다.
        layer.update(SWITCH_FX.life, 0, DEFAULT_RENDER_OPTIONS);
        expect(calls.some((c) => c.fn === 'fillCircle')).toBe(false);
    });

    it('starts dimmer when the player asked for less flashing', () => {
        const bright = fakeScene();
        const brightLayer = new SwitchFxLayer(bright.scene as never);
        brightLayer.play(0, 0, 50, 0, 0);
        brightLayer.update(0, 0, DEFAULT_RENDER_OPTIONS);

        const dim = fakeScene();
        const dimLayer = new SwitchFxLayer(dim.scene as never);
        dimLayer.play(0, 0, 50, 0, 0);
        dimLayer.update(0, 0, { ...DEFAULT_RENDER_OPTIONS, reduceFlash: true });

        const alphaOf = (calls: Call[]) => calls.find((c) => c.fn === 'fillStyle')!.args[1]!;
        expect(alphaOf(dim.calls)).toBeLessThan(alphaOf(bright.calls));
    });
});
