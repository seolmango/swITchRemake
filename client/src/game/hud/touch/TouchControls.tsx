import React, { useState } from 'react';
import { overlayRoot } from '../../../components/layout/forcedLandscape.ts';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../../types.ts';
import type { HudSkill, HudState } from '../hudTypes.ts';
import { Color, statusInkColors } from '../../../theme/color.ts';
import type { ColorVisionMode } from '../../../theme/cvd.ts';
import { useSettingsStore } from '../../../stores/useSettingsStore.ts';
import { HUD_FONT } from '../hudTheme.ts';
import { ActionJoystick } from './ActionJoystick.tsx';
import type { ActionMode } from './actionMode.ts';
import { MoveJoystick } from './MoveJoystick.tsx';
import { TOUCH_BASE_SIZE, TOUCH_Z, actionWheelReach, placeAnchor } from './touchLayout.ts';
import { useViewportSize } from './useViewportSize.ts';

interface Props {
    theme: Theme;
    colorVision: ColorVisionMode;
    hud: HudState;
    onUseMovementSkill: () => void;
    onSwitchTarget: (playerId: number) => void;
    onEmoji: (emojiId: number) => void;
}

/**
 * 터치 조작 겹판.
 *
 * **`document.body`로 포털해서 1920x1080 스테이지 밖에 그린다.** 게임 화면은 `GameContainer`가
 * `transform: scale()`로 줄인 고정 크기 무대라 위아래(또는 좌우)에 검은 띠가 남는다. 조이스틱을
 * 그 안에 두면 같이 줄어들어 손가락보다 작아지고, 남는 띠는 못 쓴다. 조작은 화면 전체를 쓴다.
 */
export const TouchControls: React.FC<Props> = ({
    theme, colorVision, hud, onUseMovementSkill, onSwitchTarget, onEmoji,
}) => {
    const { t } = useTranslation();
    const scale = useSettingsStore((state) => state.touchScale);
    const moveAnchor = useSettingsStore((state) => state.touchMoveAnchor);
    const actionAnchor = useSettingsStore((state) => state.touchActionAnchor);
    const viewport = useViewportSize();
    const switchCooldown = hud.switchSkill?.cooldown ?? 0;
    const switchRatio = hud.switchSkill && hud.switchSkill.cooldownTotal > 0
        ? Math.max(0, Math.min(1, switchCooldown / hud.switchSkill.cooldownTotal)) : 0;
    const [mode, setMode] = useState<ActionMode>('switch');

    const size = TOUCH_BASE_SIZE * scale;
    const reach = actionWheelReach(size);
    const move = placeAnchor(moveAnchor, viewport, size / 2);
    const action = placeAnchor(actionAnchor, viewport, reach);

    const self = hud.players.find((player) => player.id === hud.selfId) ?? null;
    // 죽었거나 관전 중이면 조작할 것이 없다. 눌리지 않는 컨트롤이 화면을 가리기만 한다.
    if (hud.selfId === null || self?.alive === false) return null;

    const handlePick = (picked: ActionMode, slot: number) => {
        if (picked === 'switch') onSwitchTarget(slot);
        else onEmoji(slot);
    };

    return createPortal(
        <div style={{
            position: 'fixed', inset: 0, zIndex: TOUCH_Z.controls, pointerEvents: 'none',
            fontFamily: HUD_FONT, touchAction: 'none',
        }}>
            <div style={{
                position: 'absolute', left: move.x, top: move.y,
                transform: 'translate(-50%, -50%)', pointerEvents: 'auto',
            }}>
                <MoveJoystick theme={theme} size={size} label={t('game.hud.touch.moveJoystick')} />
            </div>

            {/* 선택기가 다른 컨트롤 위에 그려지도록 z를 올린다. 아래 깔리면 무엇을 고르는지 안 보인다. */}
            <div style={{
                position: 'absolute', left: action.x, top: action.y, zIndex: 2,
                transform: 'translate(-50%, -50%)', pointerEvents: 'auto',
            }}>
                <ActionJoystick
                    theme={theme}
                    colorVision={colorVision}
                    size={size}
                    mode={mode}
                    players={hud.players}
                    joystickLabel={t(mode === 'switch' ? 'game.hud.touch.switchJoystick' : 'game.hud.touch.emojiJoystick')}
                    wheelLabel={t(mode === 'switch' ? 'game.hud.touch.switch' : 'game.hud.touch.emoji')}
                    wheelHint={t('game.hud.touch.pick')}
                    onPick={handlePick}
                />
                {/*
                  * 스위치 재사용 대기. 키보드 화면은 스킬바가 보여 주지만 터치에서는 스킬바를 숨기므로,
                  * 예전에는 폰에서 쿨타임을 볼 곳이 없었다. 조이스틱 위에 줄어드는 고리와 초를 겹친다.
                  */}
                {mode === 'switch' && switchCooldown > 0 && (
                    <SwitchCooldown theme={theme} size={size} ratio={switchRatio} seconds={switchCooldown}/>
                )}
            </div>

            {/* 조이스틱 바로 위. 자주 누르는 것이 아니라 엄지 자리를 양보해도 된다. */}
            <div style={{
                position: 'absolute', left: action.x, top: action.y - size * 0.78,
                transform: 'translate(-50%, -50%)', pointerEvents: 'auto',
            }}>
                <ModeToggle
                    theme={theme}
                    mode={mode}
                    scale={scale}
                    // 이모지 쪽을 보고 있어도 스위치가 언제 다시 되는지 알 수 있게 탭에도 남은 초를 붙인다.
                    labels={{ switch: switchCooldown > 0 ? `${t('game.hud.touch.switch')} ${Math.ceil(switchCooldown)}` : t('game.hud.touch.switch'), emoji: t('game.hud.touch.emoji') }}
                    onChange={setMode}
                />
            </div>

            {/* 이동기는 방향이 필요 없다. 누르면 나가는 버튼이 조이스틱보다 빠르고 오조작도 없다. */}
            {hud.movementSkill && (
                <div style={{
                    position: 'absolute',
                    left: action.x - size * 0.95,
                    top: action.y - size * 0.72,
                    transform: 'translate(-50%, -50%)', pointerEvents: 'auto',
                }}>
                    <SkillButton theme={theme} skill={hud.movementSkill} size={size * 0.74} onUse={onUseMovementSkill} />
                </div>
            )}
        </div>,
        overlayRoot(),
    );
};

const ModeToggle: React.FC<{
    theme: Theme;
    mode: ActionMode;
    scale: number;
    labels: Record<ActionMode, string>;
    onChange: (mode: ActionMode) => void;
}> = ({ theme, mode, scale, labels, onChange }) => {
    const pad = 8 * scale;
    const font = 15 * scale;
    const infoInk = statusInkColors(theme).info;

    return (
        <div style={{
            display: 'flex', borderRadius: 'var(--radius-sm)', overflow: 'hidden', touchAction: 'none',
            border: `3px solid ${Color.smoke[2]}`,
            background: `color-mix(in srgb, ${theme === 1 ? Color.black : Color.white} 62%, transparent)`,
            backdropFilter: 'blur(2px)',
        }}>
            {(Object.keys(labels) as ActionMode[]).map((value) => {
                const selected = mode === value;
                return (
                    <button
                        key={value}
                        type="button"
                        // pointerdown으로 받는다. click은 손을 뗀 뒤에 오고 조이스틱의 포인터 캡처와 겹친다.
                        onPointerDown={(event) => { event.preventDefault(); onChange(value); }}
                        style={{
                            minHeight: 48 * scale, padding: `${pad}px ${pad * 1.9}px`, border: 'none', cursor: 'pointer',
                            fontFamily: HUD_FONT, fontSize: font, fontWeight: 800, whiteSpace: 'nowrap',
                            background: selected ? infoInk : 'transparent',
                            color: selected ? (theme === 1 ? Color.black : Color.white) : (theme === 1 ? Color.white : Color.black),
                        }}
                    >
                        {labels[value]}
                    </button>
                );
            })}
        </div>
    );
};

const SkillButton: React.FC<{
    theme: Theme;
    skill: HudSkill;
    size: number;
    onUse: () => void;
}> = ({ theme, skill, size, onUse }) => {
    const ready = skill.cooldown <= 0 && !skill.unavailable;
    const ratio = skill.cooldownTotal > 0 ? Math.max(0, Math.min(1, skill.cooldown / skill.cooldownTotal)) : 0;
    const infoInk = statusInkColors(theme).info;

    return (
        <button
            type="button"
            onPointerDown={(event) => { event.preventDefault(); if (ready) onUse(); }}
            disabled={!ready}
            aria-label={skill.label}
            style={{
                position: 'relative', width: size, height: size, borderRadius: '50%', padding: 0,
                touchAction: 'none', overflow: 'hidden',
                background: `color-mix(in srgb, ${theme === 1 ? Color.black : Color.white} 62%, transparent)`,
                border: `4px solid ${ready ? infoInk : Color.smoke[2]}`,
                boxShadow: ready ? `0 0 0 4px color-mix(in srgb, ${infoInk} 30%, transparent)` : 'none',
                backdropFilter: 'blur(2px)',
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
                        position: 'absolute', inset: 0, pointerEvents: 'none',
                        background: `conic-gradient(color-mix(in srgb, ${Color.black} 55%, transparent) ${ratio * 360}deg, transparent 0deg)`,
                    }} />
                    <span style={{
                        position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                        fontFamily: HUD_FONT, fontSize: size * 0.34, fontWeight: 800,
                        color: theme === 1 ? Color.white : Color.black, pointerEvents: 'none',
                    }}>{Math.ceil(skill.cooldown)}</span>
                </>
            )}
        </button>
    );
};

/** 스위치 조이스틱 위에 겹치는 재사용 대기 표시. 손가락 입력은 그대로 조이스틱이 받는다. */
const SwitchCooldown: React.FC<{ theme: Theme; size: number; ratio: number; seconds: number }> = ({ theme, size, ratio, seconds }) => (
    <div aria-hidden="true" style={{
        position: 'absolute', left: '50%', top: '50%', width: size, height: size,
        transform: 'translate(-50%, -50%)', borderRadius: '50%', pointerEvents: 'none',
        background: `conic-gradient(color-mix(in srgb, ${Color.black} 50%, transparent) ${ratio * 360}deg, transparent 0deg)`,
        display: 'grid', placeItems: 'center',
    }}>
        <span style={{
            fontFamily: HUD_FONT, fontSize: size * 0.3, fontWeight: 800,
            color: theme === 1 ? Color.white : Color.black,
        }}>{Math.ceil(seconds)}</span>
    </div>
);
