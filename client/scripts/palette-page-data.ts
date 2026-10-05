// 팔레트 미리보기 페이지용 데이터. `node client/scripts/palette-page-data.ts > out.json`
import { Color } from '../src/theme/color.ts';
import { colorVisionPalette, type ColorVisionMode } from '../src/theme/cvd.ts';
import { hexToLinear, linearToHex, minPairDelta, simulate, visionDelta, type VisionKind } from '../src/theme/colorScience.ts';

const OLD: Record<ColorVisionMode, string[]> = {
    off: ['#FFD5B8', '#FCE6A9', '#D7EBA4', '#B5E3C8', '#C4D7B8', '#CDC1F0', '#E6C8E6', '#E8D4BE'],
    protanopia: ['#FAE178', '#A0CDFF', '#82C8D7', '#A0C378', '#F58C7D', '#FF7DA0', '#91A0FF', '#EB82CD'],
    deuteranopia: ['#F5E196', '#FFD26E', '#69C8FF', '#E69B69', '#EB91A5', '#78B4B4', '#69B978', '#6EAFCD'],
    tritanopia: ['#F0E1BE', '#E1E67D', '#B9B991', '#A0B473', '#AAA0F5', '#C391F0', '#CD96B4', '#69AAF0'],
};
const kindOf: Record<ColorVisionMode, VisionKind> = { off: 'normal', protanopia: 'protanopia', deuteranopia: 'deuteranopia', tritanopia: 'tritanopia' };
const sim = (hex: string, kind: VisionKind) => linearToHex(simulate(hexToLinear(hex), kind));
const reserved = [...Color.red, ...Color.blue];
const out = (['off', 'protanopia', 'deuteranopia', 'tritanopia'] as ColorVisionMode[]).map((mode) => {
    const kind = kindOf[mode];
    const pal = colorVisionPalette(mode);
    const fills = pal.user.map((p) => p[0]!);
    const nearestReserved = (list: string[]) => Math.min(...list.flatMap((h) => reserved.map((r) => visionDelta(h, r, kind))));
    return {
        mode,
        pairs: pal.user,
        seen: pal.user.map((p) => [sim(p[0]!, kind), sim(p[1]!, kind)]),
        oldFills: OLD[mode],
        oldSeen: OLD[mode].map((h) => sim(h, kind)),
        minNew: +minPairDelta(fills, kind).toFixed(1),
        minOld: +minPairDelta(OLD[mode], kind).toFixed(1),
        normalNew: +minPairDelta(fills, 'normal').toFixed(1),
        reservedNew: +nearestReserved(fills).toFixed(1),
        reservedOld: +nearestReserved(OLD[mode]).toFixed(1),
        ui: { red: Color.red.map((h) => sim(h, kind)), blue: Color.blue.map((h) => sim(h, kind)), grass: pal.grass.map((h) => sim(h, kind)), frenzy: pal.frenzy.map((h) => sim(h, kind)) },
    };
});
console.log(JSON.stringify(out));
