import type { CSSProperties } from 'react';
import { Color, statusInkColors, themeColors } from '../../theme/color.ts';
import { userColorsFor, type ColorVisionMode } from '../../theme/cvd.ts';
import type { Theme } from '../types.ts';

/**
 * Light mode keeps the pastel fill and uses a darker ink; dark mode drops the coloured fill but keeps a
 * black backing under world-overlaid text. Centralised here so every HUD piece stays consistent instead
 * of each re-deriving it.
 *
 * Legacy drew all of this into the canvas with fixed 1600x900 coordinates, which is why it ended up
 * cramped and low-contrast. These are plain DOM styles, so spacing and contrast can be tuned freely.
 */

export type Tone = 'red' | 'blue' | 'gray' | 'frenzy';

const RAMP: Record<Tone, readonly string[]> = {
    red: Color.red,
    blue: Color.blue,
    gray: Color.gray,
    frenzy: Color.frenzy,
};

export const surface = (theme: Theme, tone: Tone, emphasis = false): CSSProperties => {
    const ramp = RAMP[tone];
    const ink = tone === 'red'
        ? statusInkColors(theme).bad
        : tone === 'blue'
            ? statusInkColors(theme).info
            : tone === 'frenzy'
                ? statusInkColors(theme).warn
                : Color.smoke[2]!;
    return {
        background: theme === 1 ? Color.black : (emphasis ? ramp[1]! : ramp[0]!),
        border: `2px solid ${ink}`,
        color: ink,
    };
};

/** Panel behind a group of HUD controls. Translucent so the world stays readable underneath. */
export const panel = (theme: Theme): CSSProperties => ({
    background: theme === 1
        ? `color-mix(in srgb, ${Color.black} 78%, transparent)`
        : `color-mix(in srgb, ${Color.white} 86%, transparent)`,
    border: `3px solid ${Color.smoke[2]}`,
    borderRadius: 18,
    backdropFilter: 'blur(6px)',
});

export const bodyText = (theme: Theme): string => (theme === 1 ? Color.white : Color.black);
export const mutedText = (theme: Theme): string => themeColors(theme).muted;

/**
 * Both halves of a player's palette slot: [fill, stroke].
 *
 * 색각 보조 모드를 인자로 받는 이유는 HUD가 월드와 반드시 같은 색을 써야 하기 때문이다 —
 * 명단의 색 점과 화면 속 본체 색이 어긋나면 "몇 번이 누구인지"라는 이 UI의 존재 이유가 사라진다.
 */
export const userColors = (colorIndex: number, colorVision: ColorVisionMode = 'off'): readonly [string, string] =>
    userColorsFor(colorIndex, colorVision);

export const HUD_FONT = 'var(--font-ui)';
export const HUD_DISPLAY_FONT = 'var(--font-display)';

export const HUD_METRICS = Object.freeze({
    corner: 18,
    cornerCompact: 12,
    panelPadding: 14,
    panelPaddingCompact: 10,
    panelGap: 12,
    panelGapCompact: 9,
    captionFont: 14,
    bodyFont: 16,
    bodyFontCompact: 16,
    badgeFont: 14,
    skillSize: 92,
    skillSizeCompact: 72,
    cooldownFont: 32,
    cooldownFontCompact: 27,
    controlRadius: 18,
    compactWidth: 820,
    compactHeight: 620,
});

export const HUD_MIN_SCREEN_PX = Object.freeze({
    caption: 11,
    body: 12,
    badge: 11,
});

/**
 * HUD-only inverse scale. At the 844×390 reference viewport it keeps captions/badges at 11px and body
 * text above 12px. The cap is deliberate: portrait phones keep the playable world ahead of typography;
 * touch controls already live outside the fixed stage and retain their physical size.
 */
export const HUD_MAX_SCALE_COMPENSATION = 2.2;
const HUD_ROUNDING_MARGIN_PX = 0.1;

export const hudScaleCompensation = (canvasScale: number): number => {
    const safeScale = Math.max(canvasScale, Number.EPSILON);
    const minimumMetricScale = Math.max(
        (HUD_MIN_SCREEN_PX.caption + HUD_ROUNDING_MARGIN_PX) / HUD_METRICS.captionFont,
        (HUD_MIN_SCREEN_PX.body + HUD_ROUNDING_MARGIN_PX) / HUD_METRICS.bodyFont,
        (HUD_MIN_SCREEN_PX.badge + HUD_ROUNDING_MARGIN_PX) / HUD_METRICS.badgeFont,
    );
    return Math.min(HUD_MAX_SCALE_COMPENSATION, Math.max(1, minimumMetricScale / safeScale));
};

export const isCompactHud = (width: number, height: number): boolean =>
    width < HUD_METRICS.compactWidth || height < HUD_METRICS.compactHeight;
