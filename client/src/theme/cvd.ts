// 색각 보조(color vision deficiency) 팔레트.
//
// "필터를 씌운다"는 접근은 여기선 쓰지 않는다. 캔버스 위에 CSS/셰이더 색행렬을 얹는 흔한 방법은
// *색각이상을 시뮬레이션*하는 것이라, 정작 색각이상 유저에게는 아무 정보도 더 주지 못한다.
// 대신 실제로 효과가 있는 방법 — 팔레트 자체를 그 유형이 구분할 수 있는 축으로 다시 고르는 것 — 을 쓴다.
// 엔진의 모든 색이 theme/color.ts 한 곳을 거치므로(=game/palette.ts가 그걸 숫자로 변환) 교체 지점이 하나다.
//
// 아래 값은 손으로 고른 게 아니라 Viénot–Brettel–Mollon(1999) 이색형 시뮬레이션 + CIELAB ΔE 기준으로
// 탐색해서 뽑았다. 제약조건:
//   · 시뮬레이션 후 플레이어 8색 상호 ΔE 최대화
//   · 큰 면적(바닥/벽/수풀/연막/자기장/배경)과 ΔE ≥ 12
//   · 얇은 선(술래 링, 유체화 링, 연막 테두리 등)과 ΔE ≥ 7
//   · 정상 색각에서도 서로 ΔE ≥ 13 (같은 화면을 보는 다른 사람 기준)
//
// 측정 결과 (플레이어 8색 중 가장 가까운 두 색의 시뮬레이션 ΔE):
//   적색약 2.5 → 17.8 / 녹색약 3.2 → 17.1 / 청황색약 2.7 → 22.3
// ΔE 2~3은 사실상 같은 색이고 10을 넘으면 "명확히 다른 색"이다. 즉 현재 팔레트는 이 세 유형에게
// 8명이 전부 같은 색으로 보이며, 교체 후에는 확실히 갈린다.
//
// 색을 못 쓰는 상황을 대비한 2차 단서(본체 번호, 술래의 깃발/링 모양)는 그대로 유지된다.

import { Color } from './color.ts';

export type ColorVisionMode = 'off' | 'protanopia' | 'deuteranopia' | 'tritanopia';

export interface ColorVisionPalette {
    /** 플레이어 8슬롯 [채움, 외곽선]. */
    user: readonly (readonly [string, string])[];
    /** 수풀 램프 [옅음, 중간, 진함]. */
    grass: readonly string[];
    /** 광란 램프. */
    frenzy: readonly string[];
}

/**
 * 술래/자기장의 빨강과 유체화의 파랑은 일부러 건드리지 않는다. "빨강 = 위험"은 세 유형 모두에서
 * 밝기·형태(링, 깃발, 사선 해칭)로 이미 뒷받침되는 관습이고, HUD·UI와도 색을 맞춰야 한다.
 * 대신 그 빨강과 충돌하는 쪽(수풀 초록, 광란 주황)을 Lab 색상환에서 회전시켜 떼어놓는다.
 * 회전각도 위와 같은 방식으로 탐색했다 — 예: 녹색약에서 수풀[1] vs 빨강[1]은 ΔE 2.1(구분 불가)이었다.
 */
const OVERRIDES: Record<Exclude<ColorVisionMode, 'off'>, ColorVisionPalette> = {
    // 적색약: 시뮬레이션 min ΔE 17.8, 정상 색각 min ΔE 21.8
    protanopia: {
        user: [
            ['#FAE178', '#DAC468'],
            ['#A0CDFF', '#8BB2DE'],
            ['#82C8D7', '#71AEBB'],
            ['#A0C378', '#8BAA68'],
            ['#F58C7D', '#D57A6D'],
            ['#FF7DA0', '#DE6D8B'],
            ['#91A0FF', '#7E8BDE'],
            ['#EB82CD', '#CC71B2'],
        ],
        grass: Color.grass,                              // 빨강과 이미 ΔE 21 — 그대로 둔다
        frenzy: ['#F1D6A4', '#E7A740', '#CD8400'],       // +18° : 수풀과 ΔE 8.3 → 분리
    },
    // 녹색약: 시뮬레이션 min ΔE 17.1, 정상 색각 min ΔE 16.3
    deuteranopia: {
        user: [
            ['#F5E196', '#D5C483'],
            ['#FFD26E', '#DEB760'],
            ['#69C8FF', '#5BAEDE'],
            ['#E69B69', '#C8875B'],
            ['#EB91A5', '#CC7E90'],
            ['#78B4B4', '#689D9D'],
            ['#69B978', '#5BA168'],
            ['#6EAFCD', '#6098B2'],
        ],
        grass: ['#FDD5F5', '#EDB3DE', '#D589C2'],        // +198° : 빨강과 ΔE 2.1 → 11.3
        frenzy: Color.frenzy,
    },
    // 청황색약: 시뮬레이션 min ΔE 22.3, 정상 색각 min ΔE 14.4
    tritanopia: {
        user: [
            ['#F0E1BE', '#D1C4A5'],
            ['#E1E67D', '#C4C86D'],
            ['#B9B991', '#A1A17E'],
            ['#A0B473', '#8B9D64'],
            ['#AAA0F5', '#948BD5'],
            ['#C391F0', '#AA7ED1'],
            ['#CD96B4', '#B2839D'],
            ['#69AAF0', '#5B94D1'],
        ],
        grass: ['#E0DCFF', '#C7BDF7', '#A399E2'],        // +162° : 파랑과 ΔE 0.0 → 분리
        frenzy: ['#DADDA6', '#BEB73C', '#A09600'],       // +42°  : 빨강과 ΔE 7 → 13.4
    },
};

const BASE: ColorVisionPalette = {
    user: Color.user.map((pair) => [pair[0]!, pair[1]!] as const),
    grass: Color.grass,
    frenzy: Color.frenzy,
};

/** 해당 모드에서 쓸 팔레트. `off`면 기본 팔레트를 그대로 돌려준다. */
export const colorVisionPalette = (mode: ColorVisionMode): ColorVisionPalette =>
    (mode === 'off' ? BASE : OVERRIDES[mode]);

/** 플레이어 슬롯 한 칸의 [채움, 외곽선]. HUD(DOM)와 엔진(Phaser)이 같은 값을 쓰도록 여기로 모은다. */
export const userColorsFor = (colorIndex: number, mode: ColorVisionMode): readonly [string, string] => {
    const { user } = colorVisionPalette(mode);
    return (user[colorIndex] ?? user[0]!) as readonly [string, string];
};
