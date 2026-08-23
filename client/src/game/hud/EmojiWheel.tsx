import React from 'react';
import type { Theme } from '../types.ts';
import { EMOJI_COUNT, emojiDataUri } from '../emoji.ts';
import { Color } from '../../theme/color.ts';
import { HUD_FONT, mutedText } from './hudTheme.ts';

interface Props {
    theme: Theme;
    compact: boolean;
    onPick: (emojiId: number) => void;
}

const RADIUS = 132;
const RADIUS_COMPACT = 92;

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
    const slot = compact ? 50 : 68;
    const iconColor = theme === 1 ? Color.white : Color.black;

    return (
        <div style={{
            position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
            background: theme === 1 ? 'rgba(0,0,0,0.45)' : 'rgba(59,59,59,0.28)',
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
                                background: theme === 1 ? 'rgba(35,37,38,0.92)' : Color.white,
                                border: `2px solid ${theme === 1 ? '#5A5E60' : Color.gray[1]}`,
                            }}
                        >
                            {uri && <img src={uri} alt={`emoji ${id}`} style={{ width: slot * 0.56, height: slot * 0.56 }} />}
                            <span style={{
                                position: 'absolute', bottom: -4, right: -4,
                                width: 20, height: 20, borderRadius: '50%', display: 'grid', placeItems: 'center',
                                fontSize: 11, fontWeight: 800,
                                background: theme === 1 ? '#5A5E60' : Color.gray[0],
                                color: theme === 1 ? Color.white : Color.black,
                            }}>{id}</span>
                        </button>
                    );
                })}

                <div style={{
                    position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
                    textAlign: 'center', color: mutedText(theme), fontSize: 12, fontWeight: 700, lineHeight: 1.7,
                }}>
                    Shift + 1~8<br />
                    <span style={{ fontSize: 11, fontWeight: 600 }}>Shift 놓으면 닫힘</span>
                </div>
            </div>
        </div>
    );
};
