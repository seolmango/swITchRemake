import { EMOJI_ID_MAX, isEmojiId } from 'shared';
import cheer from '../assets/images/01-cheer.svg?raw';
import wink from '../assets/images/02-wink.svg?raw';
import content from '../assets/images/03-content.svg?raw';
import surprised from '../assets/images/04-surprised.svg?raw';
import flustered from '../assets/images/05-flustered.svg?raw';
import angry from '../assets/images/06-angry.svg?raw';
import sad from '../assets/images/07-sad.svg?raw';
import neutral from '../assets/images/08-neutral.svg?raw';

/**
 * Emoji ids are part of the wire contract (`emojiId` in the PLAYERS section — see shared/src/protocol/snapshot.ts), so
 * this ordering is fixed at `EMOJI_ID_MIN`..`EMOJI_ID_MAX` and must not be reshuffled. Index 0 is
 * unused so the id matches the asset's filename prefix.
 *
 * Imported as source text rather than as URLs on purpose. Phaser's `load.svg` base64-encodes with
 * `btoa`, which throws on these files (their `aria-label`/`<title>` are Korean), and the artwork is
 * stroked with `currentColor` — meaningless once rasterised outside the DOM, so the colour has to be
 * substituted before encoding anyway.
 */
const EMOJI_SVG: readonly string[] = [
    '', cheer, wink, content, surprised, flustered, angry, sad, neutral,
];

export const EMOJI_COUNT = EMOJI_ID_MAX;

/*
 * 그림 수와 계약이 어긋나면 부팅할 때 죽는다.
 *
 * 조용히 넘어가면 두 가지 중 하나가 된다. 그림이 모자라면 서버가 통과시킨 번호를 아무도 못 그리고,
 * 남으면 그린 적 없는 그림이 영영 안 나온다. 둘 다 "가끔 이모지가 안 보인다"로만 보여서 원인을
 * 찾기 어렵다. 여기서 죽으면 그림을 추가한 사람이 그 자리에서 안다.
 */
if (EMOJI_SVG.length - 1 !== EMOJI_ID_MAX) {
    throw new Error(`emoji artwork count (${EMOJI_SVG.length - 1}) does not match the wire contract (${EMOJI_ID_MAX})`);
}

/** Textures are per-theme (the artwork is monochrome line work), so the key carries the theme. */
export const emojiTextureKey = (id: number, theme: 0 | 1): string => `emoji-${id}-${theme}`;

export { isEmojiId };

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
