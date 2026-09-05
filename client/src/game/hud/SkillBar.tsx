import React from 'react';
import type { Theme } from '../types.ts';
import type { HudSkill } from './hudTypes.ts';
import { Color, statusInkColors } from '../../theme/color.ts';
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
    const statusInk = statusInkColors(theme);

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
                    border: `3px solid ${ready ? statusInk.info : Color.smoke[2]}`,
                    boxShadow: ready ? `0 0 0 3px color-mix(in srgb, ${statusInk.info} 38%, transparent)` : 'none',
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
                color: blockedReason ? statusInk.bad : (ready ? bodyText(theme) : mutedText(theme)),
                padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap',
                border: `2px solid ${ready ? Color.smoke[2] : 'transparent'}`,
            }}>{blockedReason ?? (skill.unavailable ? '—' : skill.label)}</span>
        </div>
    );
};

/**
 * Bottom-right, matching legacy's placement (RenderingManager.js:390-396) — under the hand that isn't on
 * the movement keys, and clear of the centre where the action is.
 *
 * 칸에는 **스킬 이름**을 찍는다. 예전에는 키를 찍었는데(게임 안에서 배울 데가 없다는 이유),
 * 터치로 하는 사람에게는 뜻이 없는 글자였고 스위치는 "1 / 2 / 3 / 4 / 5 / 6 / 7 / 8"이라 폰
 * 가로에서 칸을 통째로 먹었다. 키는 `ControlsGuide`가 이미 가르친다 — 거기서 Space와 1~8을
 * 스킬 이름과 함께 보여 주고, 설정의 "조작 힌트 항상 표시"로 계속 띄워 둘 수도 있다.
 *
 * 쿨다운은 버튼 전체의 투명도가 아니라 줄어드는 부채꼴이다. 투명도만으로는 "1초 남음"과
 * "방금 눌렀음"이 거의 같아 보였다.
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
