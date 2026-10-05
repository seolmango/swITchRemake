import { Color, themeColors } from './color.ts';
import { colorVisionPalette, uiStatusColorsFor, type ColorVisionMode } from './cvd.ts';
import type { MotionLevel } from '../stores/useSettingsStore.ts';

type Theme = 0 | 1;
type CssVariables = Record<`--${string}`, string>;

/**
 * React 화면과 CSS가 같은 팔레트를 보도록 색을 한 번만 내려준다.
 * 수풀·광란을 뜻으로 쓰는 성공/주의 색은 색각 보조 팔레트를 반드시 거친다.
 */
export const appearanceCssVariables = (theme: Theme, colorVisionMode: ColorVisionMode, highContrast = false): CssVariables => {
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
        /*
         * 플레이어 8슬롯의 채움색. 색각 보조 팔레트를 거친 값이라야 한다 — HUD 명단 점은
         * JS에서 `userColorsFor`로 같은 값을 받고 있는데, CSS 쪽만 빠지면 같은 플레이어가
         * 두 화면에서 다른 색이 된다(BASE.md §12.5).
         */
        ...Object.fromEntries(vision.user.map((pair, index) => [`--color-user-${index}`, pair[0]])) as Record<`--color-user-${number}`, string>,
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
        '--theme-border': highContrast ? colors.text : colors.panelBorder,
        '--ui-accent-fill': highContrast && theme === 0 ? status.info : Color.blue[0]!,
        '--ui-accent-text': highContrast && theme === 0 ? Color.white : Color.black,
        '--ui-blue-border': highContrast ? status.info : Color.blue[2]!,
        '--ui-red-border': highContrast ? status.bad : Color.red[2]!,
        '--ui-neutral-border': highContrast ? colors.text : Color.gray[2]!,
        '--hud-panel-opacity': highContrast ? '100%' : theme === 0 ? '86%' : '78%',
        '--hud-border-width': highContrast ? '3px' : '2px',
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

/**
 * 설치한 앱의 상태 표시줄과 주소창이 앱 배경과 같은 색이 되게 한다. index.html의 값은
 * 첫 화면용 기본값이고, 사용자가 고른 테마는 시스템 설정과 다를 수 있어 여기서 덮어쓴다.
 */
const applyThemeColorMeta = (canvas: string): void => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', canvas);
};

export const applyAppearanceToDocument = (
    theme: Theme,
    motionLevel: MotionLevel,
    colorVisionMode: ColorVisionMode,
    highContrast = false,
): void => {
    const root = document.documentElement;
    root.style.colorScheme = theme === 0 ? 'light' : 'dark';
    root.dataset.theme = theme === 0 ? 'light' : 'dark';
    root.dataset.motion = motionLevel;
    root.dataset.contrast = highContrast ? 'high' : 'standard';
    root.dataset.colorVision = colorVisionMode;
    for (const [name, value] of Object.entries(appearanceCssVariables(theme, colorVisionMode, highContrast))) {
        root.style.setProperty(name, value);
    }
    applyThemeColorMeta(themeColors(theme).canvas);
};
