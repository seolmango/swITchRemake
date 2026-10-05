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
import { appearanceCssVariables } from './cssVariables.ts';
import { colorVisionPalette, userColorsFor, type ColorVisionMode } from './cvd.ts';
import { minPairDelta, visionDelta, type VisionKind } from './colorScience.ts';
import { skillIconSvg } from './skillIcons.ts';

const COLOR_VISION_MODES: ColorVisionMode[] = ['off', 'protanopia', 'deuteranopia', 'tritanopia'];

type Rgb = readonly [number, number, number];

const hexToRgb = (hex: string): Rgb => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255) as unknown as Rgb;
const linear = (channel: number): number => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

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
    it.each([0, 1] as const)('theme %i selected controls remain readable in both contrast modes', (theme) => {
        for (const highContrast of [false, true]) {
            const palette = appearanceCssVariables(theme, 'off', highContrast);
            expect(contrast(palette['--ui-accent-text']!, palette['--ui-accent-fill']!)).toBeGreaterThanOrEqual(4.5);
        }
        expect(appearanceCssVariables(theme, 'off')['--ui-blue-border']).toBe(Color.blue[2]);
        expect(appearanceCssVariables(theme, 'off', true)['--ui-blue-border']).toBe(statusInkColors(theme).info);
    });

    it('dialog surfaces are opaque in both themes', () => {
        for (const theme of [0, 1] as const) {
            expect(themeColors(theme).panel).toMatch(/^#[0-9a-f]{6}$/i);
            expect(themeColors(theme).field).toMatch(/^#[0-9a-f]{6}$/i);
        }
    });

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

/*
 * 색약 보조에 대해 **구현에 무관하게 참인 것만** 고정한다. 위에서 ΔE 문턱을 뺀 것과 같은
 * 이유로 "이 색들이 구분된다"는 주장은 테스트하지 않는다. 대신 그 주장이 성립할 *기회*를
 * 없애 버리는 구조적 실패를 잡는다 — 팔레트가 비거나 짧아 폴백으로 뭉개지는 것, 두 슬롯이
 * 아예 같은 색인 것, 그리고 색이 팔레트를 거치지 않고 화면까지 새는 것.
 *
 * 마지막 항목이 실제로 났던 사고다. `index.css`가 `--color-user-0`을 읽고 있었는데 그 변수를
 * 아무도 정의하지 않아, 색약 모드를 켜도 CSS fallback 값이 영구히 남았다.
 */
describe('color vision palette coverage', () => {
    it.each(COLOR_VISION_MODES)('%s palette keeps the base shape so nothing falls back', (mode) => {
        const palette = colorVisionPalette(mode);
        expect(palette.user).toHaveLength(Color.user.length);
        expect(palette.grass).toHaveLength(Color.grass.length);
        expect(palette.frenzy).toHaveLength(Color.frenzy.length);
        for (const pair of palette.user) {
            expect(pair).toHaveLength(2);
            for (const hex of pair) expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
        }
    });

    it.each(COLOR_VISION_MODES)('%s gives each of the 8 slots its own colour', (mode) => {
        // 같은 색이 두 슬롯에 들어가면 어떤 색각 모형에서도 그 둘은 구분되지 않는다.
        const fills = colorVisionPalette(mode).user.map((pair) => pair[0]!.toUpperCase());
        expect(new Set(fills).size).toBe(fills.length);
    });

    it.each(COLOR_VISION_MODES.filter((mode) => mode !== 'off'))('%s actually differs from the default palette', (mode) => {
        // 모드를 골랐는데 아무것도 안 바뀌면 그 선택지는 거짓말이다.
        expect(JSON.stringify(colorVisionPalette(mode))).not.toBe(JSON.stringify(colorVisionPalette('off')));
    });

    it.each(COLOR_VISION_MODES)('%s exposes every player colour to CSS through the vision palette', (mode) => {
        const vars = appearanceCssVariables(0, mode);
        for (let slot = 0; slot < Color.user.length; slot += 1) {
            // HUD 명단 점(JS)과 CSS가 같은 함수를 거쳐야 한 플레이어가 두 화면에서 같은 색이 된다.
            expect(vars[`--color-user-${slot}`]).toBe(userColorsFor(slot, mode)[0]);
        }
    });

    it.each(COLOR_VISION_MODES)('%s routes terrain and frenzy ramps through the vision palette', (mode) => {
        const vars = appearanceCssVariables(0, mode);
        const palette = colorVisionPalette(mode);
        for (let step = 0; step < 3; step += 1) {
            expect(vars[`--color-grass-${step}`]).toBe(palette.grass[step]);
            expect(vars[`--color-frenzy-${step}`]).toBe(palette.frenzy[step]);
        }
    });

    /*
     * 문턱은 저장소 안의 한 구현(colorScience.ts: Machado 2009 + CIEDE2000)으로 잰 값이다.
     * 팔레트는 client/scripts/palette-search.ts가 찾았고, 이 테스트가 그 결과가 무너지지 않게 막는다.
     */
    const VISION: Record<ColorVisionMode, VisionKind> = { off: 'normal', protanopia: 'protanopia', deuteranopia: 'deuteranopia', tritanopia: 'tritanopia' };
    const PLAYER_MIN: Record<ColorVisionMode, number> = { off: 17, protanopia: 11.5, deuteranopia: 11, tritanopia: 17.5 };

    it.each(COLOR_VISION_MODES)('%s keeps the 8 players apart as that vision sees them', (mode) => {
        const fills = colorVisionPalette(mode).user.map((pair) => pair[0]!);
        expect(minPairDelta(fills, VISION[mode])).toBeGreaterThanOrEqual(PLAYER_MIN[mode]);
        // 같은 화면을 정상 색각으로 보는 다른 플레이어에게도 갈려야 한다.
        expect(minPairDelta(fills, 'normal')).toBeGreaterThanOrEqual(13);
    });

    it.each(COLOR_VISION_MODES)('%s never paints a player like the tagger red or the system blue', (mode) => {
        // UI가 쓰는 빨강·파랑과 플레이어가 겹치면, 그 플레이어가 술래나 '나'로 읽힌다.
        for (const [fill] of colorVisionPalette(mode).user) {
            for (const reserved of [...Color.red, ...Color.blue]) {
                expect(visionDelta(fill!, reserved, VISION[mode])).toBeGreaterThanOrEqual(mode === 'off' ? 12 : 10);
            }
        }
    });

    it('never paints a player colour from a literal that skips the palette', () => {
        /*
         * `var(--color-user-N, #hex)` 같은 폴백은 변수가 사라져도 조용히 돌아가서, 색약 모드가
         * 안 먹는다는 사실을 숨긴다. 폴백이 없으면 변수가 빠진 순간 눈에 보이게 깨진다.
         */
        const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
        expect(css).not.toMatch(/var\(\s*--color-user-\d+\s*,/u);
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

describe('skill icons follow the colour vision palette', () => {
    const VISION: Record<ColorVisionMode, VisionKind> = { off: 'normal', protanopia: 'protanopia', deuteranopia: 'deuteranopia', tritanopia: 'tritanopia' };

    it.each(COLOR_VISION_MODES)('%s gives Flash its own colour, apart from Dash blue, tagger red and the terrain', (mode) => {
        const palette = colorVisionPalette(mode);
        const [fill] = palette.skillFlash;
        for (const other of [...Color.blue, ...Color.red, ...palette.grass]) {
            expect(visionDelta(fill, other, VISION[mode])).toBeGreaterThanOrEqual(10);
        }
        // 스킬 색은 플레이어 색이 아니다 — 같으면 그 번호가 스킬의 주인처럼 보인다.
        for (const [player] of palette.user) expect(fill).not.toBe(player);
    });

    it.each(COLOR_VISION_MODES.filter((mode) => mode !== 'off'))('%s repaints Flash and Exhaust icons so no default colour is left', (mode) => {
        const palette = colorVisionPalette(mode);
        const flash = skillIconSvg('flash', mode);
        expect(flash).toContain(palette.skillFlash[0]);
        expect(flash).toContain(palette.skillFlash[1]);
        expect(flash).not.toContain(Color.skillFlash[0]);
        const exhaust = skillIconSvg('exhaust', mode);
        expect(exhaust).toContain(palette.grass[0]!);
        if (palette.grass[0] !== Color.grass[0]) expect(exhaust).not.toContain(Color.grass[0]!);
    });

    it('the default icons are drawn in exactly the default palette', () => {
        // 원본 SVG의 색이 곧 기본값이라야 다른 모드에서 바꿀 자리를 찾을 수 있다.
        expect(skillIconSvg('flash', 'off')).toContain(Color.skillFlash[0]);
        expect(skillIconSvg('flash', 'off')).toContain(Color.skillFlash[1]);
        expect(skillIconSvg('exhaust', 'off')).toContain(Color.grass[0]!);
    });
});
