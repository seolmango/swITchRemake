import React from 'react';
import type { Theme } from '../types.ts';
import type { HudPlayer } from './hudTypes.ts';
import { Color } from '../../theme/color.ts';
import { HUD_FONT, bodyText, mutedText, panel } from './hudTheme.ts';

interface Props {
    theme: Theme;
    spectating: boolean;
    compact: boolean;
    elapsedSec: number | null;
    selfIsTagger: boolean;
    watching: HudPlayer | null;
    /** Eliminated mid-match — distinct from having joined as a spectator. */
    deadInMatch: boolean;
}

const clock = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
};

/**
 * Top-left status: elapsed time, plus the facts a player most needs pushed at them rather than inferred —
 * "you are the tagger", "you're out", and whose view this is while spectating.
 *
 * Legacy showed none of these. Being the tagger was only discoverable by noticing your own ring colour on
 * the field, which is easy to miss in the exact moment it changes and matters most.
 */
export const StatusBar: React.FC<Props> = ({ theme, spectating, compact, elapsedSec, selfIsTagger, watching, deadInMatch }) => (
    <div style={{
        position: 'absolute', top: compact ? 10 : 16, left: compact ? 10 : 16,
        display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start', fontFamily: HUD_FONT,
    }}>
        {elapsedSec !== null && (
            <div style={{ ...panel(theme), padding: compact ? '4px 10px' : '6px 14px', display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ color: mutedText(theme), fontSize: 10, fontWeight: 700, letterSpacing: 0.5 }}>경과</span>
                <span style={{ color: bodyText(theme), fontSize: compact ? 14 : 17, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                    {clock(elapsedSec)}
                </span>
            </div>
        )}

        {spectating && (
            <div style={{ ...panel(theme), padding: compact ? '4px 9px' : '6px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: mutedText(theme), fontSize: 11, fontWeight: 700 }}>
                    {deadInMatch ? '탈락 · 관전' : '관전 중'}
                </span>
                {watching && (
                    <span style={{ color: bodyText(theme), fontSize: compact ? 12 : 13, fontWeight: 800 }}>
                        {watching.nickname || `Player ${watching.id + 1}`}
                    </span>
                )}
            </div>
        )}

        {selfIsTagger && (
            <div style={{
                padding: compact ? '5px 11px' : '7px 14px', borderRadius: 12, whiteSpace: 'nowrap',
                background: Color.red[2], color: Color.white,
                fontSize: compact ? 12 : 13, fontWeight: 800, letterSpacing: 0.5,
                boxShadow: '0 2px 10px rgba(255,113,113,0.45)',
            }}>당신이 술래입니다</div>
        )}
    </div>
);
