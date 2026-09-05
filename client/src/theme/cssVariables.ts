import { Color, themeColors } from './color.ts';
import { colorVisionPalette, uiStatusColorsFor, type ColorVisionMode } from './cvd.ts';
import type { MotionLevel } from '../stores/useSettingsStore.ts';

type Theme = 0 | 1;
type CssVariables = Record<`--${string}`, string>;

/**
 * React 화면과 CSS가 같은 팔레트를 보도록 색을 한 번만 내려준다.
 * 수풀·광란을 뜻으로 쓰는 성공/주의 색은 색각 보조 팔레트를 반드시 거친다.
 */
export const appearanceCssVariables = (theme: Theme, colorVisionMode: ColorVisionMode): CssVariables => {
    const colors = themeColors(theme);
    const vision = colorVisionPalette(colorVisionMode);
    const status = uiStatusColorsFor(colorVisionMode, theme);
    return {
        '--color-white': Color.white,
        '--color-black': Color.black,
        '--color-letterbox': Color.letterbox,
        '--color-red-0': Color.red[0]!,
        '--color-red-1': Color.red[1]!,
        '--color-red-2': Color.red[2]!,
        '--color-blue-0': Color.blue[0]!,
        '--color-blue-1': Color.blue[1]!,
        '--color-blue-2': Color.blue[2]!,
        '--color-gray-0': Color.gray[0]!,
        '--color-gray-1': Color.gray[1]!,
        '--color-gray-2': Color.gray[2]!,
        '--color-smoke-0': Color.smoke[0]!,
        '--color-smoke-1': Color.smoke[1]!,
        '--color-smoke-2': Color.smoke[2]!,
        '--color-grass-0': vision.grass[0]!,
        '--color-grass-1': vision.grass[1]!,
        '--color-grass-2': vision.grass[2]!,
        '--color-frenzy-0': vision.frenzy[0]!,
        '--color-frenzy-1': vision.frenzy[1]!,
        '--color-frenzy-2': vision.frenzy[2]!,
        '--theme-canvas': colors.canvas,
        '--theme-text': colors.text,
        '--theme-muted': colors.muted,
        '--theme-panel': colors.panel,
        '--theme-border': colors.panelBorder,
        '--theme-field': colors.field,
        '--theme-backdrop': colors.backdrop,
        '--theme-focus': colors.focus,
        '--semantic-good': status.good,
        '--semantic-warn': status.warn,
        '--semantic-bad': status.bad,
        '--semantic-info': status.info,
        '--semantic-good-fill': status.goodFill,
        '--semantic-warn-fill': status.warnFill,
        '--semantic-bad-fill': status.badFill,
        '--semantic-info-fill': status.infoFill,
    };
};

export const applyAppearanceToDocument = (
    theme: Theme,
    motionLevel: MotionLevel,
    colorVisionMode: ColorVisionMode,
): void => {
    const root = document.documentElement;
    root.style.colorScheme = theme === 0 ? 'light' : 'dark';
    root.dataset.theme = theme === 0 ? 'light' : 'dark';
    root.dataset.motion = motionLevel;
    root.dataset.colorVision = colorVisionMode;
    for (const [name, value] of Object.entries(appearanceCssVariables(theme, colorVisionMode))) {
        root.style.setProperty(name, value);
    }
};
