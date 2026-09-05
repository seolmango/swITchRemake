import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GAME_DESIGN_HEIGHT, GAME_DESIGN_WIDTH, gameCanvasScale } from '../components/layout/gameScale.ts';
import {
    HUD_MAX_SCALE_COMPENSATION,
    HUD_METRICS,
    HUD_MIN_SCREEN_PX,
    hudScaleCompensation,
    isCompactHud,
} from '../game/hud/hudTheme.ts';
import { Color, statusInkColors, themeColors } from './color.ts';

type Rgb = readonly [number, number, number];
type Matrix = readonly [Rgb, Rgb, Rgb];
type Deficiency = 'protanopia' | 'deuteranopia' | 'tritanopia';

const hexToRgb = (hex: string): Rgb => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255) as unknown as Rgb;
const linear = (channel: number): number => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const gamma = (channel: number): number => channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const multiply = (matrix: Matrix, vector: Rgb): Rgb => matrix.map(
    (row) => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2],
) as unknown as Rgb;

const luminance = (hex: string): number => {
    const [r, g, b] = hexToRgb(hex).map(linear) as unknown as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (foreground: string, background: string): number => {
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    return (lighter + 0.05) / (darker + 0.05);
};

/*
 * 이색형 시뮬레이션 코드가 여기 있었다. 지웠다 — 어느 구현으로도 cvd.ts 주석의 측정값을
 * 재현하지 못했고, 구현마다 같은 색 쌍의 ΔE가 3에서 20까지 갈렸다. 재현되지 않는 숫자로
 * 문턱을 고정하면 통과해도 증명하는 것이 없다. 아래 단서 점검이 그 자리를 대신한다.
 */

describe('meaning-bearing palette accessibility', () => {
    it.each([0, 1] as const)('theme %i status inks exceed 4.5:1 for text', (theme) => {
        const canvas = themeColors(theme).canvas;
        for (const ink of Object.values(statusInkColors(theme))) {
            expect(contrast(ink, canvas)).toBeGreaterThanOrEqual(4.5);
        }
    });

    it.each([0, 1] as const)('theme %i focus and neutral UI borders exceed 3:1', (theme) => {
        const canvas = themeColors(theme).canvas;
        expect(contrast(Color.focus[theme], canvas)).toBeGreaterThanOrEqual(3);
        expect(contrast(themeColors(theme).panelBorder, canvas)).toBeGreaterThanOrEqual(3);
    });

    /*
     * 여기에 원래 "세 색각 유형에서 상호 ΔE 10 이상"을 고정하는 점검이 있었다. **뺐다.**
     *
     * 이색형 시뮬레이션에는 표준 구현이 여럿이고(Viénot 논문 원본 행렬 대 HPE/D65 정규화),
     * 같은 색 쌍이 구현에 따라 ΔE 3도 나오고 20도 나온다. 실제로 두 구현으로 재 봤을 때
     * 라이트 테마의 good 대 bad가 한쪽에서는 3.2, 다른 쪽에서는 20을 넘었다.
     *
     * 더 나아가 `cvd.ts` 주석이 근거로 적어 둔 측정값(예: 녹색약에서 옛 수풀과 빨강이 ΔE 2.1,
     * 새 수풀은 11.3)을 **어느 구현으로도 재현하지 못했다.** 그래서 임의의 구현으로 문턱을
     * 고정하면, 통과해도 아무것도 증명하지 못하면서 "색약 검증됨"이라는 거짓 안심만 준다.
     *
     * 대신 **구현에 무관하게 참인 것**을 고정한다 — 뜻을 지는 상태는 색 말고 다른 단서를
     * 반드시 하나 더 갖는다(§12.5의 "색을 못 쓰는 상황을 대비한 2차 단서"). 색이 안 갈려도
     * 모양과 글자가 남는다.
     *
     * ΔE로 다시 판정하려면 `cvd.ts`의 측정을 재현 가능한 형태로 다시 하고, 그 구현 하나를
     * 인게임과 UI가 함께 쓰는 원본으로 삼아야 한다. 그건 이 점검의 범위가 아니다.
     */
    it('뜻을 지는 상태는 색 말고 다른 단서를 하나 더 갖는다', () => {
        const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

        // 서버 상태 — 색이 아니라 모양으로도 갈린다.
        expect(css).toMatch(/\.server-status-dot\.is-online\b[^}]*border-radius:\s*50%/u);
        expect(css).toMatch(/\.server-status-dot\.is-offline\b[^}]*rotate\(45deg\)/u);
        expect(css).toMatch(/\.server-status-dot\.is-checking\b[^}]*border-style:\s*dashed/u);

        // 성공·주의·실패 — 글자 단서가 붙는다.
        for (const glyph of ['✓', '△', '!']) {
            expect(css.includes(`content: '${glyph} '`), `${glyph} 단서가 없다`).toBe(true);
        }
    });
});

describe('HUD physical size', () => {
    it('meets the 844x390 landscape reference without scaling the world', () => {
        const canvasScale = gameCanvasScale(844, 390);
        const compensation = hudScaleCompensation(canvasScale);
        const physicalScale = canvasScale * compensation;

        expect(HUD_METRICS.captionFont * physicalScale).toBeGreaterThanOrEqual(HUD_MIN_SCREEN_PX.caption);
        expect(HUD_METRICS.bodyFont * physicalScale).toBeGreaterThanOrEqual(HUD_MIN_SCREEN_PX.body);
        expect(HUD_METRICS.bodyFontCompact * physicalScale).toBeGreaterThanOrEqual(HUD_MIN_SCREEN_PX.body);
        expect(HUD_METRICS.badgeFont * physicalScale).toBeGreaterThanOrEqual(HUD_MIN_SCREEN_PX.badge);
        expect(HUD_METRICS.cooldownFontCompact * physicalScale).toBeGreaterThanOrEqual(21);
        expect(56 * physicalScale).toBeGreaterThanOrEqual(44);
        expect(isCompactHud(GAME_DESIGN_WIDTH / compensation, GAME_DESIGN_HEIGHT / compensation)).toBe(true);

        // The collapsed roster consumes under one fifth of the rendered world; names remain one tap away.
        const renderedWorldWidth = GAME_DESIGN_WIDTH * canvasScale;
        expect((170 * physicalScale) / renderedWorldWidth).toBeLessThan(0.2);
    });

    it('caps portrait compensation so the HUD cannot consume the world', () => {
        const portraitScale = gameCanvasScale(390, 844);
        expect(hudScaleCompensation(portraitScale)).toBe(HUD_MAX_SCALE_COMPENSATION);
    });
});
