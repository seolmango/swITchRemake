// 점멸 스킬 색을 색각 모드마다 고른다. `node client/scripts/skill-color-search.ts`
// 조건: 유체화 파랑·술래 빨강·그 모드의 수풀과 시뮬레이션 거리 최대, 플레이어 8색과도 떨어진다.
import { Color } from '../src/theme/color.ts';
import { colorVisionPalette, type ColorVisionMode } from '../src/theme/cvd.ts';
import { lchToHex, visionDelta, type VisionKind } from '../src/theme/colorScience.ts';

const kindOf: Record<ColorVisionMode, VisionKind> = { off: 'normal', protanopia: 'protanopia', deuteranopia: 'deuteranopia', tritanopia: 'tritanopia' };
for (const mode of ['off', 'protanopia', 'deuteranopia', 'tritanopia'] as ColorVisionMode[]) {
    const kind = kindOf[mode];
    const pal = colorVisionPalette(mode);
    const others = [...Color.blue, ...Color.red, ...pal.grass, ...pal.frenzy];
    let best = { score: -1, fill: '', stroke: '' };
    for (let h = 0; h < 360; h += 3) for (let L = 66; L <= 86; L += 2) for (let C = 30; C <= 56; C += 2) {
        const fill = lchToHex(L, C, h);
        const stroke = lchToHex(L - 18, C, h);
        if (!fill || !stroke) continue;
        // 기본 모드는 점멸의 원래 정체성(보라) 근처에서만 찾는다 — 아이콘·로비 스킬 카드와 같은 계열.
        if (mode === 'off' && (h < 285 || h > 320)) continue;
        const near = Math.min(...others.map((o) => visionDelta(fill, o, kind)));
        const players = Math.min(...pal.user.map((p) => visionDelta(fill, p[0]!, kind)));
        const score = Math.min(near, players + 4);
        if (score > best.score) best = { score, fill, stroke };
    }
    console.log(mode.padEnd(13), best.fill, best.stroke, 'minΔE', best.score.toFixed(1));
}
