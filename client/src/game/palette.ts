// Numeric (Phaser-friendly) view of client/src/theme/color.ts — the single
// source of truth for colors. Nothing in game/ should hardcode a hex value;
// add new shades to theme/color.ts and expose them here instead.
import { Color } from '../theme/color.ts';
import { colorVisionPalette, type ColorVisionMode } from '../theme/cvd.ts';

const toNum = (hex: string): number => parseInt(hex.slice(1), 16);
const toNumArray = (hexes: readonly string[]): number[] => hexes.map(toNum);

/**
 * Mutated in place by `applyColorVision` rather than rebuilt, so every module that did
 * `import { Palette }` keeps reading live values without threading a palette argument through
 * every draw call. Safe because the whole app renders one world at a time; a second engine on a
 * different mode would need this to become per-instance state.
 */
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

let currentMode: ColorVisionMode = 'off';

/**
 * Swaps the palette to the color-vision variant for `mode`. Only the entries a variant actually
 * redefines move — see theme/cvd.ts for why these three and how the values were picked.
 * Returns whether anything changed, so the caller can skip a redraw of the baked static layer.
 */
export function applyColorVision(mode: ColorVisionMode): boolean {
    if (mode === currentMode) return false;
    currentMode = mode;
    const next = colorVisionPalette(mode);
    Palette.grass = toNumArray(next.grass) as [number, number, number];
    Palette.frenzy = toNumArray(next.frenzy) as [number, number, number];
    Palette.user = next.user.map((pair) => toNumArray(pair)) as [number, number][];
    return true;
}

/** rgba(hex, alpha) as a Phaser fillStyle/strokeStyle-compatible {color, alpha} pair is usually simpler,
 * but some draw calls need a packed CSS-style string (e.g. gradient stops) — this covers that case. */
export function rgba(color: number, alpha: number): string {
    const r = (color >> 16) & 255;
    const g = (color >> 8) & 255;
    const b = color & 255;
    return `rgba(${r},${g},${b},${alpha})`;
}
