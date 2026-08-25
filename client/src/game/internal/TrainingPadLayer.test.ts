import { describe, expect, it } from 'vitest';
import { TrainingPadKind } from 'shared';
import { TrainingPadLayer } from './TrainingPadLayer.ts';
import { DEPTH } from './depth.ts';

interface Call { fn: string; args: Array<number | string> }

function fakeScene() {
    const calls: Call[] = [];
    const gfx = {
        setDepth: (depth: number) => { calls.push({ fn: 'graphicsDepth', args: [depth] }); return gfx; },
        clear: () => { calls.push({ fn: 'clear', args: [] }); },
        fillStyle: (color: number, alpha: number) => { calls.push({ fn: 'fillStyle', args: [color, alpha] }); },
        fillCircle: (x: number, y: number, radius: number) => { calls.push({ fn: 'fillCircle', args: [x, y, radius] }); },
        lineStyle: (width: number, color: number, alpha: number) => { calls.push({ fn: 'lineStyle', args: [width, color, alpha] }); },
        strokeCircle: (x: number, y: number, radius: number) => { calls.push({ fn: 'strokeCircle', args: [x, y, radius] }); },
        beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, strokePath: () => {}, arc: () => {}, fillTriangle: () => {},
        destroy: () => {},
    };
    const image = {
        setDisplaySize: (width: number, height: number) => { calls.push({ fn: 'imageSize', args: [width, height] }); return image; },
        setDepth: (depth: number) => { calls.push({ fn: 'imageDepth', args: [depth] }); return image; },
        setAlpha: () => image,
        destroy: () => {},
    };
    return {
        calls,
        scene: {
            add: {
                graphics: () => gfx,
                image: (x: number, y: number, key: string) => {
                    calls.push({ fn: 'image', args: [x, y, key] });
                    return image;
                },
            },
        },
    };
}

describe('training pad layer', () => {
    it('draws the server radius without substituting a presentation radius', () => {
        const { scene, calls } = fakeScene();
        const layer = new TrainingPadLayer(scene as never, 0);
        layer.setPads([{ kind: TrainingPadKind.SkillDash, x: 320, y: 480, radius: 137 }]);

        expect(calls.find((call) => call.fn === 'fillCircle')?.args).toEqual([320, 480, 137]);
        expect(calls.find((call) => call.fn === 'strokeCircle')?.args).toEqual([320, 480, 137]);
        expect(calls.find((call) => call.fn === 'graphicsDepth')?.args).toEqual([DEPTH.trainingPad]);
        expect(calls.find((call) => call.fn === 'imageDepth')?.args).toEqual([DEPTH.trainingPadIcon]);
    });

    it('uses distinct skill textures while tagger and reset remain shape icons', () => {
        const { scene, calls } = fakeScene();
        const layer = new TrainingPadLayer(scene as never, 1);
        layer.setPads([
            { kind: TrainingPadKind.SkillDash, x: 0, y: 0, radius: 80 },
            { kind: TrainingPadKind.SkillFlash, x: 100, y: 0, radius: 80 },
            { kind: TrainingPadKind.SkillExhaust, x: 200, y: 0, radius: 80 },
            { kind: TrainingPadKind.Tagger, x: 300, y: 0, radius: 80 },
            { kind: TrainingPadKind.Reset, x: 400, y: 0, radius: 80 },
        ]);

        expect(calls.filter((call) => call.fn === 'image').map((call) => call.args[2])).toEqual([
            'training-pad-dash', 'training-pad-flash', 'training-pad-exhaust',
        ]);
        expect(calls.filter((call) => call.fn === 'fillCircle')).toHaveLength(5);
    });
});
