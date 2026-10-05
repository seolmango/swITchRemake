// 색각 보조(color vision deficiency) 팔레트.
//
// "필터를 씌운다"는 접근은 쓰지 않는다. 캔버스 위에 색행렬을 얹는 흔한 방법은 색각이상을
// *시뮬레이션*하는 것이라, 정작 색각이상 유저에게는 아무 정보도 더 주지 못한다. 대신 팔레트
// 자체를 그 유형이 구분할 수 있는 색으로 다시 고른다. 엔진의 모든 색이 theme/color.ts를 거치므로
// (game/palette.ts가 숫자로 변환) 교체 지점이 하나다.
//
// ## 어떻게 골랐나 (재현 가능)
// 시뮬레이션은 저장소 안의 한 구현만 쓴다 — theme/colorScience.ts(Machado 2009 심도 1.0 +
// CIEDE2000). 값은 client/scripts/palette-search.ts가 찾았다:
//   · 그 유형으로 시뮬레이션한 8색의 최소 상호 거리를 최대화
//   · 술래 빨강·시스템 파랑과 시뮬레이션 거리 10 이상, 수풀·광란과 6 이상
//   · 같은 화면을 보는 정상 색각 플레이어를 위해 정상 거리 13 이상
//   · 밝기를 60~92로 넓힌다. 이색형 색각에서는 밝기가 거의 유일하게 남는 축이라, 파스텔의
//     좁은 밝기 안에서는 8색이 갈라질 자리가 없다. 채도는 파스텔 범위(46 이하)로 묶는다.
//
// 결과 (가장 가까운 두 플레이어, 시뮬레이션 ΔE00): 적색약 7.9 → 12.0 / 녹색약 5.3 → 11.5 /
// 청황색약 7.3 → 18.2. 이전 팔레트는 일부 플레이어가 술래 빨강·지형과 ΔE 1.5~3.2로 사실상 같은
// 색이었다. accessibility.test.ts가 이 문턱을 같은 구현으로 고정한다.
//
// 색만으로 끝내지 않는다. 본체 번호와 술래의 깃발·링 모양이 2차 단서로 남는다.

import { Color, statusInkColors } from './color.ts';

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
    protanopia: {
        user: [
            ['#C7894F', '#996129'],
            ['#E6EF94', '#B8C26A'],
            ['#A0BF6C', '#759444'],
            ['#489E95', '#12756C'],
            ['#6CFEF7', '#2ED0C9'],
            ['#8ABAC8', '#60909D'],
            ['#5D93DE', '#276AB1'],
            ['#AF83A5', '#855B7C'],
        ],
        grass: Color.grass,                              // 빨강과 이미 ΔE 21 — 그대로 둔다
        frenzy: ['#F1D6A4', '#E7A740', '#CD8400'],       // +18° : 수풀과 ΔE 8.3 → 분리
    },
    deuteranopia: {
        user: [
            ['#F6CA7A', '#C69F51'],
            ['#91936F', '#686A48'],
            ['#90B59F', '#678A75'],
            ['#BDE6DB', '#92B9AE'],
            ['#35A18C', '#0E7564'],
            ['#5D94E2', '#276CB5'],
            ['#8A90B0', '#616786'],
            ['#C1A9BE', '#967F93'],
        ],
        grass: ['#FDD5F5', '#EDB3DE', '#D589C2'],        // +198° : 빨강과 ΔE 2.1 → 11.3
        frenzy: Color.frenzy,
    },
    tritanopia: {
        user: [
            ['#BD8460', '#905C3A'],
            ['#85984E', '#5C6F27'],
            ['#D8F29A', '#ABC56F'],
            ['#3EA275', '#0D774F'],
            ['#81F9D6', '#51CBAA'],
            ['#A4B0F4', '#7985C7'],
            ['#AA8FCA', '#80669E'],
            ['#FBE0FE', '#CDB3D0'],
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

/**
 * React UI의 상태색. 파스텔 fill은 선택한 색각 팔레트를 따르고, 뜻을 지는 ink는 세 유형을 모두
 * 통과한 공용 팔레트라 모드와 관계없이 유지된다.
 */
export const uiStatusColorsFor = (mode: ColorVisionMode, theme: 0 | 1) => {
    const palette = colorVisionPalette(mode);
    const ink = statusInkColors(theme);
    return {
        ...ink,
        checking: ink.warn,
        goodFill: palette.grass[0]!,
        warnFill: palette.frenzy[0]!,
        badFill: Color.red[0]!,
        infoFill: Color.blue[0]!,
    } as const;
};
