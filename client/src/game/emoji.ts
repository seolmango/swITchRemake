import cheer from '../assets/images/01-cheer.svg?raw';
import wink from '../assets/images/02-wink.svg?raw';
import content from '../assets/images/03-content.svg?raw';
import surprised from '../assets/images/04-surprised.svg?raw';
import flustered from '../assets/images/05-flustered.svg?raw';
import angry from '../assets/images/06-angry.svg?raw';
import sad from '../assets/images/07-sad.svg?raw';
import neutral from '../assets/images/08-neutral.svg?raw';

/**
 * Emoji ids are part of the wire contract (`emojiId` in the PLAYERS section — see docs/ENGINE.md), so
 * this ordering is fixed at 1..8 and must not be reshuffled. Index 0 is unused so the id matches the
 * asset's filename prefix.
 *
 * Imported as source text rather than as URLs on purpose. Phaser's `load.svg` base64-encodes with
 * `btoa`, which throws on these files (their `aria-label`/`<title>` are Korean), and the artwork is
 * stroked with `currentColor` — meaningless once rasterised outside the DOM, so the colour has to be
 * substituted before encoding anyway.
 */
const EMOJI_SVG: readonly string[] = [
    '', cheer, wink, content, surprised, flustered, angry, sad, neutral,
];

export const EMOJI_COUNT = EMOJI_SVG.length - 1;

/** Textures are per-theme (the artwork is monochrome line work), so the key carries the theme. */
export const emojiTextureKey = (id: number, theme: 0 | 1): string => `emoji-${id}-${theme}`;

export const isEmojiId = (id: number): boolean => Number.isInteger(id) && id >= 1 && id <= EMOJI_COUNT;

/**
 * Rewrites one emoji SVG into a directly-loadable data URI: forces the render size (the source files are
 * 48px, far too small for a 256px world sprite) and resolves `currentColor` to a real colour.
 *
 * URI-encoded rather than base64 so the Korean text inside survives — this is exactly what Phaser's own
 * SVG loader gets wrong.
 */
export function emojiDataUri(id: number, color: string, sizePx: number): string | null {
    const raw = EMOJI_SVG[id];
    if (!raw) return null;

    const openTag = raw.match(/<svg\b[^>]*>/);
    if (!openTag) return null;
    const resized = openTag[0]
        .replace(/\s(?:width|height)="[^"]*"/g, '')
        .replace(/^<svg\b/, `<svg width="${sizePx}" height="${sizePx}"`);

    const svg = (raw.slice(0, openTag.index) + resized + raw.slice(openTag.index! + openTag[0].length))
        .replace(/currentColor/g, color);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
