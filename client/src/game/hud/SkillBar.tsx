import React from 'react';
import type { Theme } from '../types.ts';
import type { HudSkill } from './hudTypes.ts';
import { Color } from '../../theme/color.ts';
import { HUD_FONT, bodyText, mutedText, panel } from './hudTheme.ts';

interface Props {
    theme: Theme;
    compact: boolean;
    movementSkill: HudSkill | null;
    switchSkill: HudSkill | null;
    onUseMovement: () => void;
    /** Why switch can't be used at all right now (e.g. you're the tagger) — distinct from cooldown. */
    switchBlockedReason: string | null;
}

const SIZE = 62;
const SIZE_COMPACT = 46;

const SkillSlot: React.FC<{
    theme: Theme;
    size: number;
    skill: HudSkill;
    onClick?: () => void;
    /** Switch has no button of its own — it fires by picking a target in the roster. */
    passive?: boolean;
    blockedReason?: string | null;
}> = ({ theme, size, skill, onClick, passive, blockedReason }) => {
    const ready = skill.cooldown <= 0 && !blockedReason;
    const ratio = skill.cooldownTotal > 0 ? Math.max(0, Math.min(1, skill.cooldown / skill.cooldownTotal)) : 0;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
            <button
                onClick={() => ready && !passive && onClick?.()}
                disabled={!ready || passive}
                title={`${skill.label} (${skill.key})`}
                style={{
                    position: 'relative', width: size, height: size, borderRadius: 15, padding: 0,
                    cursor: ready && !passive ? 'pointer' : 'default',
                    background: theme === 1 ? '#2E3132' : Color.white,
                    // Ready reads as a lit blue rim, so availability is legible without reading the number.
                    border: `2px solid ${ready ? Color.blue[2] : (theme === 1 ? '#4A4D4F' : Color.gray[1])}`,
                    boxShadow: ready ? `0 0 0 2px ${theme === 1 ? 'rgba(113,185,255,0.22)' : 'rgba(113,185,255,0.32)'}` : 'none',
                    overflow: 'hidden',
                    transition: 'border-color 120ms ease-out, box-shadow 120ms ease-out',
                }}
            >
                <img
                    src={skill.iconUrl}
                    alt=""
                    style={{
                        width: size - 14, height: size - 14, objectFit: 'contain',
                        filter: ready ? 'none' : 'grayscale(0.85)', opacity: ready ? 1 : 0.45,
                    }}
                />
                {ratio > 0 && (
                    <>
                        <span style={{
                            position: 'absolute', inset: 0,
                            background: `conic-gradient(rgba(0,0,0,0.55) ${ratio * 360}deg, transparent 0deg)`,
                            pointerEvents: 'none',
                        }} />
                        <span style={{
                            position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                            fontSize: 21, fontWeight: 800, color: Color.white,
                            textShadow: '0 1px 3px rgba(0,0,0,0.75)', pointerEvents: 'none',
                        }}>{Math.ceil(skill.cooldown)}</span>
                    </>
                )}
            </button>
            {/* A blocked skill states *why* — otherwise it looks identical to one on cooldown, and the
                player has no way to learn that being the tagger disables switch entirely. */}
            <span style={{
                fontSize: 10, fontWeight: 800, letterSpacing: 0.4,
                color: blockedReason ? Color.red[2] : (ready ? bodyText(theme) : mutedText(theme)),
                padding: '1px 7px', borderRadius: 999, whiteSpace: 'nowrap',
                border: `1.5px solid ${ready ? (theme === 1 ? '#5A5E60' : Color.gray[1]) : 'transparent'}`,
            }}>{blockedReason ?? skill.key}</span>
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
    const size = compact ? SIZE_COMPACT : SIZE;
    return (
        <div style={{
            ...panel(theme),
            position: 'absolute', right: compact ? 10 : 16, bottom: compact ? 10 : 16,
            padding: compact ? 7 : 10, display: 'flex', gap: compact ? 7 : 10,
            alignItems: 'flex-end', fontFamily: HUD_FONT,
        }}>
            {movementSkill && <SkillSlot theme={theme} size={size} skill={movementSkill} onClick={onUseMovement} />}
            {switchSkill && <SkillSlot theme={theme} size={size} skill={switchSkill} passive blockedReason={switchBlockedReason} />}
        </div>
    );
};
