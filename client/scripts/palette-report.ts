// 현재 팔레트를 colorScience 구현으로 잰다. `node client/scripts/palette-report.ts`
import { Color } from '../src/theme/color.ts';
import { colorVisionPalette, type ColorVisionMode } from '../src/theme/cvd.ts';
import { minPairDelta, visionDelta, type VisionKind } from '../src/theme/colorScience.ts';

const kindOf: Record<ColorVisionMode, VisionKind> = { off: 'normal', protanopia: 'protanopia', deuteranopia: 'deuteranopia', tritanopia: 'tritanopia' };
for (const mode of ['off', 'protanopia', 'deuteranopia', 'tritanopia'] as ColorVisionMode[]) {
    const palette = colorVisionPalette(mode);
    const fills = palette.user.map((p) => p[0]!);
    const kind = kindOf[mode];
    const reserved = [...Color.red, ...Color.blue, ...palette.grass, ...palette.frenzy];
    let reservedMin = Infinity;
    for (const f of fills) for (const r of reserved) reservedMin = Math.min(reservedMin, visionDelta(f, r, kind));
    console.log(`${mode.padEnd(13)} players(sim) ${minPairDelta(fills, kind).toFixed(1)}  players(normal) ${minPairDelta(fills, 'normal').toFixed(1)}  vs reserved(sim) ${reservedMin.toFixed(1)}`);
}
