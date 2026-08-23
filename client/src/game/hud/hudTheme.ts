import type { CSSProperties } from 'react';
import { Color } from '../../theme/color.ts';
import { userColorsFor, type ColorVisionMode } from '../../theme/cvd.ts';
import type { Theme } from '../types.ts';

/**
 * The HUD follows the same light/dark rule as `RoundButton`: light mode fills with the pastel tone and
 * writes in near-black, dark mode drops the fill entirely and carries the colour in the border and text.
 * Centralised here so every HUD piece stays consistent instead of each re-deriving it.
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
    const border = emphasis ? ramp[2]! : ramp[1]!;
    return {
        background: theme === 1 ? 'transparent' : (emphasis ? ramp[1]! : ramp[0]!),
        border: `2px solid ${border}`,
        color: theme === 1 ? border : Color.black,
    };
};

/** Panel behind a group of HUD controls. Translucent so the world stays readable underneath. */
export const panel = (theme: Theme): CSSProperties => ({
    background: theme === 1 ? 'rgba(35,37,38,0.72)' : 'rgba(250,250,248,0.82)',
    border: `2px solid ${theme === 1 ? '#4A4D4F' : '#E4E4E0'}`,
    borderRadius: 14,
    backdropFilter: 'blur(6px)',
});

export const bodyText = (theme: Theme): string => (theme === 1 ? Color.white : Color.black);
export const mutedText = (theme: Theme): string => (theme === 1 ? '#9BA0A3' : '#8A8A8A');

/**
 * Both halves of a player's palette slot: [fill, stroke].
 *
 * 색각 보조 모드를 인자로 받는 이유는 HUD가 월드와 반드시 같은 색을 써야 하기 때문이다 —
 * 명단의 색 점과 화면 속 본체 색이 어긋나면 "몇 번이 누구인지"라는 이 UI의 존재 이유가 사라진다.
 */
export const userColors = (colorIndex: number, colorVision: ColorVisionMode = 'off'): readonly [string, string] =>
    userColorsFor(colorIndex, colorVision);

export const HUD_FONT = 'ui-sans-serif, system-ui, sans-serif';
