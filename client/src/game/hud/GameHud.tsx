import React, { useEffect, useRef, useState } from 'react';
import { EngineMode, type Theme } from '../types.ts';
import type { HudState } from './hudTypes.ts';
import { PlayerList } from './PlayerList.tsx';
import { SkillBar } from './SkillBar.tsx';
import { EmojiWheel } from './EmojiWheel.tsx';
import { StatusBar } from './StatusBar.tsx';
import { ControlsGuide } from './ControlsGuide.tsx';
import { AlertStack } from './AlertStack.tsx';
import { HUD_FONT, HUD_METRICS, isCompactHud } from './hudTheme.ts';
import type { ColorVisionMode } from '../../theme/cvd.ts';

interface Props {
    theme: Theme;
    mode: EngineMode;
    hud: HudState;
    /** 월드와 같은 플레이어 색을 쓰기 위해 명단으로 내려보낸다. */
    colorVision: ColorVisionMode;
    /** 설정의 '조작 힌트 표시'. 끄면 좌하단 키 안내 패널이 사라진다. */
    showControlHints: boolean;
    matchReady: boolean;
    onUseMovementSkill: () => void;
    onSwitchTarget: (playerId: number) => void;
    onSpectate: (playerId: number) => void;
    onEmoji: (emojiId: number) => void;
}

/**
 * Screen-anchored overlay above the Phaser world. Everything here stays a fixed size regardless of camera
 * zoom, which is exactly the line that decides what lives here versus in the world: if it should scale
 * and move with the player it belongs to the engine, otherwise it belongs here.
 *
 * `pointerEvents: none` on the root keeps camera drag/zoom working through the gaps; each control opts
 * itself back in.
 *
 * The three modes share this one component rather than forking, because they differ only in which pieces
 * are present: spectating drops the skill bar and repurposes the roster into a camera picker, help adds
 * the controls reference, play is the full set.
 */
export const GameHud: React.FC<Props> = ({
    theme, mode, hud, colorVision, showControlHints, matchReady, onUseMovementSkill, onSwitchTarget, onSpectate, onEmoji,
}) => {
    const [shiftHeld, setShiftHeld] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [compact, setCompact] = useState(false);
    const [showIntroHints, setShowIntroHints] = useState(matchReady && mode !== EngineMode.Help);

    const self = hud.players.find((p) => p.id === hud.selfId) ?? null;
    /**
     * Dying turns you into a spectator without rebuilding anything: the engine keeps running and only the
     * HUD's presentation changes. That's why "am I spectating" is derived from whether I have a living
     * self rather than read off the construction-time mode.
     */
    const spectating = mode === EngineMode.Spectate || (self !== null && !self.alive);
    const canAct = !spectating && hud.selfId !== null;

    // Panels are corner-anchored at fixed sizes, so on a small viewport they overlap. Measured rather
    // than media-queried because the HUD sizes to its container, which needn't be the window.
    useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        const observer = new ResizeObserver(([entry]) => {
            if (!entry) return;
            const { width, height } = entry.contentRect;
            setCompact(isCompactHud(width, height));
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!showIntroHints) return;
        const timer = window.setTimeout(() => setShowIntroHints(false), 5_000);
        return () => window.clearTimeout(timer);
    }, [showIntroHints]);

    /**
     * Emoji input, straight from legacy: hold Shift to raise the wheel, Shift+1‥8 to send. Keyed off
     * `event.code` rather than `event.key` because with Shift down the digits arrive as `!@#$%^&*`, which
     * is layout-dependent — `Digit1`‥`Digit8` is not.
     *
     * The listeners stay attached regardless of `canAct` so Shift tracking can't go stale while
     * spectating; only the send is gated, and the wheel's render already checks `canAct`.
     *
     * `blur` matters here: alt-tabbing while Shift is down never delivers the keyup, and the wheel would
     * otherwise stay stuck open.
     */
    useEffect(() => {
        const onDown = (e: KeyboardEvent) => {
            if (e.key === 'Shift') setShiftHeld(true);
        };
        const onUp = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(false); };
        const onBlur = () => setShiftHeld(false);

        window.addEventListener('keydown', onDown);
        window.addEventListener('keyup', onUp);
        window.addEventListener('blur', onBlur);
        return () => {
            window.removeEventListener('keydown', onDown);
            window.removeEventListener('keyup', onUp);
            window.removeEventListener('blur', onBlur);
        };
    }, []);

    const deadInMatch = mode !== EngineMode.Spectate && self !== null && !self.alive;

    return (
        <div
            ref={rootRef}
            /*
             * HUD 뿌리에 이름을 붙여 둔다. 안쪽 조각들은 전부 인라인 스타일이라 밖에서 잡을
             * 손잡이가 하나도 없었다 — 화면 자동 점검이 "경기 화면에 들어왔다"를 판정할 방법이
             * 없으면 그 흐름은 점검할 수 없다.
             */
            className="game-hud"
            data-hud-mode={mode}
            data-hud-ready={matchReady ? 'true' : 'false'}
            data-hud-spectating={spectating ? 'true' : 'false'}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none', fontFamily: HUD_FONT }}
        >
            <StatusBar
                theme={theme}
                spectating={spectating}
                compact={compact}
                elapsedSec={hud.elapsedSec}
                selfIsTagger={!spectating && self?.isTagger === true}
                watching={hud.players.find((p) => p.id === hud.spectatingId) ?? null}
                deadInMatch={deadInMatch}
            />

            <div style={{ pointerEvents: 'auto' }}>
                <PlayerList
                    theme={theme}
                    colorVision={colorVision}
                    compact={compact}
                    players={hud.players}
                    selfId={hud.selfId}
                    switchTargets={canAct ? hud.switchTargets : []}
                    onSwitchTarget={onSwitchTarget}
                    spectating={spectating}
                    spectatingId={hud.spectatingId}
                    onSpectate={onSpectate}
                />
            </div>

            {/* No out-of-zone warning: the storm is a solid boundary the server collides against, so a
                player can never be outside it in the first place. */}
            <AlertStack theme={theme} alerts={hud.alerts} offsetTop={HUD_METRICS.corner + 8} compact={compact} />

            {/* 도움말 모드에서만 띄우던 것을 설정으로 옮겼다 — 문구가 "경기 중"을 약속하므로 인게임에서도 뜬다.
                좁은 화면에서는 여전히 접는다(좌하단이 다른 패널과 겹친다). */}
            {(showControlHints || showIntroHints) && !compact && (
                <ControlsGuide theme={theme} movementSkillLabel={hud.movementSkill?.label ?? null} />
            )}

            {canAct && (hud.movementSkill || hud.switchSkill) && (
                <div style={{ pointerEvents: 'auto' }}>
                    <SkillBar
                        theme={theme}
                        compact={compact}
                        movementSkill={hud.movementSkill}
                        switchSkill={hud.switchSkill}
                        onUseMovement={onUseMovementSkill}
                        switchBlockedReason={self?.isTagger ? '술래는 사용 불가' : null}
                    />
                </div>
            )}

            {shiftHeld && canAct && (
                <div style={{ position: 'absolute', inset: 0, pointerEvents: 'auto' }}>
                    <EmojiWheel theme={theme} compact={compact} onPick={onEmoji} />
                </div>
            )}
        </div>
    );
};
