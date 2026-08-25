import React from 'react';
import type { Theme } from '../types.ts';
import { EMOJI_COUNT, emojiDataUri } from '../emoji.ts';
import { Color } from '../../theme/color.ts';
import { HUD_FONT, HUD_METRICS, mutedText } from './hudTheme.ts';

interface Props {
    theme: Theme;
    compact: boolean;
    onPick: (emojiId: number) => void;
}

const RADIUS = 145;
const RADIUS_COMPACT = 104;

/**
 * Legacy's radial picker (RenderingManager.js:404-425), rebuilt as DOM.
 *
 * The interaction is legacy's, not a toggle menu: holding Shift shows the wheel (`main.js:295`) and
 * Shift+1‥8 picks (the `!@#$%^&*` entries in EventManager's keymap are literally the shifted digits).
 * Nothing here binds keys — the parent owns that, since it also owns whether Shift is currently down.
 *
 * Clicking still works for mouse users, which legacy didn't offer.
 */
export const EmojiWheel: React.FC<Props> = ({ theme, compact, onPick }) => {
    const radius = compact ? RADIUS_COMPACT : RADIUS;
    const slot = compact ? 60 : 78;
    const iconColor = theme === 1 ? Color.white : Color.black;

    return (
        <div style={{
            position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
            background: `color-mix(in srgb, ${Color.black} ${theme === 1 ? 45 : 28}%, transparent)`,
            backdropFilter: 'blur(2px)', fontFamily: HUD_FONT,
        }}>
            <div style={{ position: 'relative', width: radius * 2 + slot + 12, height: radius * 2 + slot + 12 }}>
                {Array.from({ length: EMOJI_COUNT }, (_, i) => {
                    const id = i + 1;
                    // Slot 1 at the top, then clockwise — matching legacy's number layout.
                    const angle = (i / EMOJI_COUNT) * Math.PI * 2 - Math.PI / 2;
                    const uri = emojiDataUri(id, iconColor, 96);
                    return (
                        <button
                            key={id}
                            onClick={() => onPick(id)}
                            style={{
                                position: 'absolute',
                                left: '50%', top: '50%',
                                transform: `translate(-50%, -50%) translate(${Math.cos(angle) * radius}px, ${Math.sin(angle) * radius}px)`,
                                width: slot, height: slot, borderRadius: '50%', padding: 0, cursor: 'pointer',
                                display: 'grid', placeItems: 'center',
                                background: theme === 1 ? Color.black : Color.white,
                                border: `3px solid ${theme === 1 ? Color.smoke[2] : Color.gray[1]}`,
                            }}
                        >
                            {uri && <img src={uri} alt={`emoji ${id}`} style={{ width: slot * 0.56, height: slot * 0.56 }} />}
                            <span style={{
                                position: 'absolute', bottom: -4, right: -4,
                                width: 26, height: 26, borderRadius: '50%', display: 'grid', placeItems: 'center',
                                fontSize: HUD_METRICS.captionFont, fontWeight: 800,
                                background: theme === 1 ? Color.smoke[2] : Color.gray[0],
                                color: theme === 1 ? Color.white : Color.black,
                            }}>{id}</span>
                        </button>
                    );
                })}

                <div style={{
                    position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
                    textAlign: 'center', color: mutedText(theme), fontSize: HUD_METRICS.bodyFont, fontWeight: 700, lineHeight: 1.7,
                }}>
                    Shift + 1~8<br />
                    <span style={{ fontSize: HUD_METRICS.captionFont, fontWeight: 600 }}>Shift 놓으면 닫힘</span>
                </div>
            </div>
        </div>
    );
};
