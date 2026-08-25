import React from 'react';
import type { Theme } from '../types.ts';
import type { HudPlayer } from './hudTypes.ts';
import { Color } from '../../theme/color.ts';
import { HUD_DISPLAY_FONT, HUD_FONT, HUD_METRICS, bodyText, mutedText, panel } from './hudTheme.ts';

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
        position: 'absolute', top: compact ? HUD_METRICS.cornerCompact : HUD_METRICS.corner, left: compact ? HUD_METRICS.cornerCompact : HUD_METRICS.corner,
        display: 'flex', flexDirection: 'column', gap: 9, alignItems: 'flex-start', fontFamily: HUD_FONT,
    }}>
        {elapsedSec !== null && (
            <div style={{ ...panel(theme), padding: compact ? '7px 12px' : '9px 16px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{ color: mutedText(theme), fontSize: HUD_METRICS.captionFont, fontWeight: 700, letterSpacing: 0.5 }}>경과</span>
                <span style={{ color: bodyText(theme), fontFamily: HUD_DISPLAY_FONT, fontSize: compact ? 19 : 24, fontWeight: 400, fontVariantNumeric: 'tabular-nums' }}>
                    {clock(elapsedSec)}
                </span>
            </div>
        )}

        {spectating && (
            <div style={{ ...panel(theme), padding: compact ? '7px 11px' : '9px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: mutedText(theme), fontSize: HUD_METRICS.bodyFontCompact, fontWeight: 700 }}>
                    {deadInMatch ? '탈락 · 관전' : '관전 중'}
                </span>
                {watching && (
                    <span style={{ color: bodyText(theme), fontSize: compact ? HUD_METRICS.bodyFontCompact : HUD_METRICS.bodyFont, fontWeight: 800 }}>
                        {watching.nickname || `Player ${watching.id}`}
                    </span>
                )}
            </div>
        )}

        {selfIsTagger && (
            <div style={{
                padding: compact ? '8px 13px' : '10px 16px', borderRadius: HUD_METRICS.controlRadius, whiteSpace: 'nowrap',
                background: Color.red[2], color: Color.white,
                fontSize: compact ? HUD_METRICS.bodyFontCompact : HUD_METRICS.bodyFont, fontWeight: 800, letterSpacing: 0.5,
                boxShadow: `0 3px 12px color-mix(in srgb, ${Color.red[2]} 48%, transparent)`,
            }}>당신이 술래입니다</div>
        )}
    </div>
);
