// Numeric (Phaser-friendly) view of client/src/theme/color.ts — the single
// source of truth for colors. Nothing in game/ should hardcode a hex value;
// add new shades to theme/color.ts and expose them here instead.
import { Color } from '../theme/color.ts';

const toNum = (hex: string): number => parseInt(hex.slice(1), 16);
const toNumArray = (hexes: readonly string[]): number[] => hexes.map(toNum);

export const Palette = {
    white: toNum(Color.white),
    black: toNum(Color.black),
    red: toNumArray(Color.red) as [number, number, number],
    blue: toNumArray(Color.blue) as [number, number, number],
    gray: toNumArray(Color.gray) as [number, number, number],
    grass: toNumArray(Color.grass) as [number, number, number],
    smoke: toNumArray(Color.smoke) as [number, number, number],
    frenzy: toNumArray(Color.frenzy) as [number, number, number],
    user: Color.user.map(toNumArray) as [number, number][],
};

/** rgba(hex, alpha) as a Phaser fillStyle/strokeStyle-compatible {color, alpha} pair is usually simpler,
 * but some draw calls need a packed CSS-style string (e.g. gradient stops) — this covers that case. */
export function rgba(color: number, alpha: number): string {
    const r = (color >> 16) & 255;
    const g = (color >> 8) & 255;
    const b = color & 255;
    return `rgba(${r},${g},${b},${alpha})`;
}
