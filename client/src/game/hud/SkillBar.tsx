import React from 'react';
import type { Theme } from '../types.ts';
import type { HudSkill } from './hudTypes.ts';
import { Color } from '../../theme/color.ts';
import { HUD_FONT, HUD_METRICS, bodyText, mutedText, panel } from './hudTheme.ts';

interface Props {
    theme: Theme;
    compact: boolean;
    movementSkill: HudSkill | null;
    switchSkill: HudSkill | null;
    onUseMovement: () => void;
    /** Why switch can't be used at all right now (e.g. you're the tagger) — distinct from cooldown. */
    switchBlockedReason: string | null;
}

const SkillSlot: React.FC<{
    theme: Theme;
    size: number;
    skill: HudSkill;
    onClick?: () => void;
    /** Switch has no button of its own — it fires by picking a target in the roster. */
    passive?: boolean;
    blockedReason?: string | null;
}> = ({ theme, size, skill, onClick, passive, blockedReason }) => {
    const ready = skill.cooldown <= 0 && !skill.unavailable && !blockedReason;
    const ratio = skill.cooldownTotal > 0 ? Math.max(0, Math.min(1, skill.cooldown / skill.cooldownTotal)) : 0;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <button
                onClick={() => ready && !passive && onClick?.()}
                disabled={!ready || passive}
                title={`${skill.label} (${skill.key})`}
                style={{
                    position: 'relative', width: size, height: size, borderRadius: HUD_METRICS.controlRadius, padding: 0,
                    cursor: ready && !passive ? 'pointer' : 'default',
                    background: theme === 1 ? Color.black : Color.white,
                    // Ready reads as a lit blue rim, so availability is legible without reading the number.
                    border: `3px solid ${ready ? Color.blue[2] : (theme === 1 ? Color.smoke[2] : Color.gray[1])}`,
                    boxShadow: ready ? `0 0 0 3px color-mix(in srgb, ${Color.blue[2]} 38%, transparent)` : 'none',
                    overflow: 'hidden',
                    transition: 'border-color 120ms ease-out, box-shadow 120ms ease-out',
                }}
            >
                <img
                    src={skill.iconUrl}
                    alt=""
                    style={{
                        width: size - 18, height: size - 18, objectFit: 'contain',
                        filter: ready ? 'none' : 'grayscale(0.85)', opacity: ready ? 1 : 0.45,
                    }}
                />
                {ratio > 0 && (
                    <>
                        <span style={{
                            position: 'absolute', inset: 0,
                            background: `conic-gradient(color-mix(in srgb, ${Color.black} 55%, transparent) ${ratio * 360}deg, transparent 0deg)`,
                            pointerEvents: 'none',
                        }} />
                        <span style={{
                            position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                            fontSize: size === HUD_METRICS.skillSizeCompact ? HUD_METRICS.cooldownFontCompact : HUD_METRICS.cooldownFont,
                            fontWeight: 800, color: Color.white,
                            textShadow: `0 2px 4px ${Color.black}`, pointerEvents: 'none',
                        }}>{Math.ceil(skill.cooldown)}</span>
                    </>
                )}
            </button>
            {/* A blocked skill states *why* — otherwise it looks identical to one on cooldown, and the
                player has no way to learn that being the tagger disables switch entirely. */}
            <span style={{
                fontSize: HUD_METRICS.badgeFont, fontWeight: 800, letterSpacing: 0.4,
                color: blockedReason ? Color.red[2] : (ready ? bodyText(theme) : mutedText(theme)),
                padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap',
                border: `2px solid ${ready ? (theme === 1 ? Color.smoke[2] : Color.gray[1]) : 'transparent'}`,
            }}>{blockedReason ?? (skill.unavailable ? '—' : skill.key)}</span>
        </div>
    );
};

/**
 * Bottom-right, matching legacy's placement (RenderingManager.js:390-396) — under the hand that isn't on
 * the movement keys, and clear of the centre where the action is.
 *
 * Two fixes over legacy: the keybind is printed on the slot (otherwise it's unlearnable in-game), and the
 * cooldown is a draining wedge instead of a whole-button alpha ramp — with alpha alone, "one second left"
 * and "just pressed" looked nearly identical.
 */
export const SkillBar: React.FC<Props> = ({ theme, compact, movementSkill, switchSkill, onUseMovement, switchBlockedReason }) => {
    const size = compact ? HUD_METRICS.skillSizeCompact : HUD_METRICS.skillSize;
    return (
        <div style={{
            ...panel(theme),
            position: 'absolute', right: compact ? HUD_METRICS.cornerCompact : HUD_METRICS.corner, bottom: compact ? HUD_METRICS.cornerCompact : HUD_METRICS.corner,
            padding: compact ? HUD_METRICS.panelPaddingCompact : HUD_METRICS.panelPadding,
            display: 'flex', gap: compact ? HUD_METRICS.panelGapCompact : HUD_METRICS.panelGap,
            alignItems: 'flex-end', fontFamily: HUD_FONT,
        }}>
            {movementSkill && <SkillSlot theme={theme} size={size} skill={movementSkill} onClick={onUseMovement} />}
            {switchSkill && <SkillSlot theme={theme} size={size} skill={switchSkill} passive blockedReason={switchBlockedReason} />}
        </div>
    );
};
