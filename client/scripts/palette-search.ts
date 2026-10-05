/**
 * 플레이어 8색을 찾는다. `node client/scripts/palette-search.ts [mode] [seed]`
 *
 * 색은 손으로 고르지 않는다. 아래 제약 안에서 "가장 가까운 두 플레이어의 거리"를 최대화하도록
 * 담금질(simulated annealing)로 찾고, 같은 구현(theme/colorScience.ts)으로 테스트가 다시 잰다.
 *
 *  - 파스텔: L* 74~92, C* 16~50.
 *  - UI 예약색(빨강=술래·위험, 파랑=시스템·나·유체화)과 수풀·광란 램프에서 떨어진다.
 *    UI가 플레이어 색을 쓰면 그 번호가 주인공처럼 보이고, 반대로 플레이어가 예약색을 쓰면
 *    술래나 '나'로 오인된다.
 *  - 색각 보조 모드는 그 유형으로 시뮬레이션한 거리를 최대화하되, 같은 화면을 보는 정상 색각
 *    플레이어를 위해 정상 거리의 하한도 지킨다.
 */
import { Color } from '../src/theme/color.ts';
import { hexToLch, lchToHex, minPairDelta, visionDelta, type VisionKind } from '../src/theme/colorScience.ts';

/*
 * PALETTE_ANCHOR="#hex,…"를 주면 그 8색에서 출발하고, 각 색이 출발점에서 멀어질수록 깎는다.
 * 사람이(또는 다른 모델이) 고른 분위기를 지키면서 구분 거리만 벌리는 미세 조정용이다.
 */
const ANCHOR = (process.env.PALETTE_ANCHOR ?? '').split(',').map((h) => h.trim()).filter(Boolean);
const ANCHOR_WEIGHT = Number(process.env.PALETTE_ANCHOR_WEIGHT ?? 0.12);

const MODE = (process.argv[2] ?? 'normal') as VisionKind;
let seed = Number(process.argv[3] ?? 7);
const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x1_0000_0000; };

const CVD_TERRAIN: Record<VisionKind, { grass: string[]; frenzy: string[] }> = {
    normal: { grass: Color.grass, frenzy: Color.frenzy },
    protanopia: { grass: Color.grass, frenzy: ['#F1D6A4', '#E7A740', '#CD8400'] },
    deuteranopia: { grass: ['#FDD5F5', '#EDB3DE', '#D589C2'], frenzy: Color.frenzy },
    tritanopia: { grass: ['#E0DCFF', '#C7BDF7', '#A399E2'], frenzy: ['#DADDA6', '#BEB73C', '#A09600'] },
};
/*
 * 예약색은 두 등급이다. 빨강(술래·자기장)과 파랑(나·유체화)은 플레이어와 절대 헷갈리면 안 된다.
 * 수풀·광란은 지형과 효과라 모양·위치로도 갈리므로 하한을 낮게 둔다.
 */
const strictReserved = [...Color.red, ...Color.blue];
const softReserved = [...CVD_TERRAIN[MODE].grass, ...CVD_TERRAIN[MODE].frenzy];

/*
 * 색약 모드는 밝기 범위를 넓힌다. 이색형 색각에서는 밝기가 거의 유일하게 남는 축이라, 파스텔의
 * 좁은 밝기 안에서는 8색이 갈라질 자리가 없다(정상 색각용 범위로 찾으면 시뮬레이션 최소 거리가
 * 7~9에서 멈춘다). 여전히 채도는 파스텔 범위에 묶어 화면의 인상은 지킨다.
 */
/*
 * 기본 모드는 '조이콘' 분위기: 밝고(L* 70~90) 또렷한(C* 34~62) 솔리드. 2026-10-05 피드백 — 너무
 * 파스텔이면 생기가 없고, 어두운 색은 칙칙하다. PALETTE_STYLE=pastel로 이전 범위를 다시 볼 수 있다.
 */
const PASTEL = process.env.PALETTE_STYLE === 'pastel';
const L_RANGE = MODE === 'normal' ? (PASTEL ? [78, 92] : [70, 90]) : [60, 92];
const C_RANGE = MODE === 'normal' ? (PASTEL ? [14, 40] : [42, 66]) : [14, 46];
const RESERVED_MIN = MODE === 'normal' ? 12 : 10;
const SOFT_RESERVED_MIN = MODE === 'normal' ? 12 : 6;
/**
 * 색상각으로도 예약색을 비운다. 거리만 재면 '파랑이지만 조금 다른 파랑'이 통과하는데, 그것도
 * 사람 눈에는 시스템 파랑(나·유체화)으로 읽힌다. LCh(ab) 각도 기준: 빨강 0~40°, 파랑 225~275°.
 */
const BLOCKED_HUES: readonly [number, number][] = [[0, 40], [225, 275]];
const hueBlocked = (h: number) => BLOCKED_HUES.some(([from, to]) => h >= from && h <= to);
type Gene = [number, number, number];
const toHex = (g: Gene) => lchToHex(g[0], g[1], g[2]);

function score(genes: Gene[]): number {
    const hexes = genes.map(toHex);
    if (hexes.some((h) => h === null)) return -1e9;
    const huePenalty = genes.filter((g) => hueBlocked(g[2])).length * -40;
    const list = hexes as string[];
    const primary = minPairDelta(list, MODE);
    const normal = MODE === 'normal' ? primary : minPairDelta(list, 'normal');
    let reservedMin = Infinity;
    let softMin = Infinity;
    for (const h of list) {
        for (const r of strictReserved) reservedMin = Math.min(reservedMin, visionDelta(h, r, MODE));
        for (const r of softReserved) softMin = Math.min(softMin, visionDelta(h, r, MODE));
    }
    // 하한을 못 넘으면 크게 깎는다. 넘으면 주 목표(가장 가까운 두 플레이어)만 본다.
    const penalty = Math.min(0, reservedMin - RESERVED_MIN) * 4 + Math.min(0, softMin - SOFT_RESERVED_MIN) * 4 + (MODE === 'normal' ? 0 : Math.min(0, normal - 13) * 4);
    const drift = ANCHOR.length === 8 ? list.reduce((sum, h, i) => sum + visionDelta(h, ANCHOR[i]!), 0) * ANCHOR_WEIGHT : 0;
    return primary + penalty + huePenalty - drift;
}

const clampGene = (g: Gene): Gene => [
    Math.min(L_RANGE[1]!, Math.max(L_RANGE[0]!, g[0])),
    Math.min(C_RANGE[1]!, Math.max(C_RANGE[0]!, g[1])),
    ((g[2] % 360) + 360) % 360,
];

let best: Gene[] = [];
let bestScore = -Infinity;
for (let restart = 0; restart < 10; restart++) {
    let genes: Gene[] = ANCHOR.length === 8
        ? ANCHOR.map((h) => hexToLch(h) as Gene)
        : Array.from({ length: 8 }, (_, i) => clampGene([L_RANGE[0]! + random() * (L_RANGE[1]! - L_RANGE[0]!), 26 + random() * 14, i * 45 + random() * 30]));
    let current = score(genes);
    for (let step = 0, temp = 4; step < 9000; step++, temp *= 0.9995) {
        const next = genes.map((g) => [...g] as Gene);
        const i = Math.floor(random() * 8);
        next[i] = clampGene([next[i]![0] + (random() - 0.5) * 6, next[i]![1] + (random() - 0.5) * 8, next[i]![2] + (random() - 0.5) * 30]);
        const s = score(next);
        if (s > current || random() < Math.exp((s - current) / temp)) { genes = next; current = s; }
        if (current > bestScore) { bestScore = current; best = genes.map((g) => [...g] as Gene); }
    }
}

// 밝기 순서가 번호 순서를 흉내 내지 않게 색상각 순으로 나열한다.
if (ANCHOR.length !== 8) best.sort((a, b) => a[2] - b[2]);
const pairs = best.map((g) => {
    const fill = toHex(g)!;
    let stroke: string | null = null;
    for (let c = g[1]; stroke === null && c >= 0; c -= 2) stroke = lchToHex(g[0] - 16, c, g[2]);
    return [fill, stroke!];
});
const fills = pairs.map((p) => p[0]!);
console.log(JSON.stringify({ mode: MODE, score: +bestScore.toFixed(2), pairs }));
for (const kind of ['normal', 'protanopia', 'deuteranopia', 'tritanopia'] as VisionKind[]) {
    console.log(`  min ΔE00 ${kind.padEnd(13)} ${minPairDelta(fills, kind).toFixed(1)}`);
}
console.log('  lch', best.map((g) => g.map((v) => Math.round(v)).join('/')).join('  '));
