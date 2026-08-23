import React, { useEffect, useRef, useState } from 'react';
import { EngineMode, type Theme } from '../types.ts';
import { EMOJI_COUNT } from '../emoji.ts';
import type { HudState } from './hudTypes.ts';
import { PlayerList } from './PlayerList.tsx';
import { SkillBar } from './SkillBar.tsx';
import { EmojiWheel } from './EmojiWheel.tsx';
import { StatusBar } from './StatusBar.tsx';
import { ControlsGuide } from './ControlsGuide.tsx';
import { AlertStack } from './AlertStack.tsx';
import { HUD_FONT } from './hudTheme.ts';

interface Props {
    theme: Theme;
    mode: EngineMode;
    hud: HudState;
    onUseMovementSkill: () => void;
    onSwitchTarget: (playerId: number) => void;
    onSpectate: (playerId: number) => void;
    onEmoji: (emojiId: number) => void;
}

/** Below either of these the corner panels start colliding, so they switch to their compact metrics. */
const COMPACT_WIDTH = 760;
const COMPACT_HEIGHT = 560;

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
    theme, mode, hud, onUseMovementSkill, onSwitchTarget, onSpectate, onEmoji,
}) => {
    const [shiftHeld, setShiftHeld] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [compact, setCompact] = useState(false);

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
            setCompact(width < COMPACT_WIDTH || height < COMPACT_HEIGHT);
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

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
            if (e.key === 'Shift') { setShiftHeld(true); return; }
            if (!canAct || !e.shiftKey) return;
            const match = /^Digit([1-8])$/.exec(e.code);
            if (!match) return;
            const id = Number(match[1]);
            if (id >= 1 && id <= EMOJI_COUNT) {
                e.preventDefault();
                onEmoji(id);
            }
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
    }, [canAct, onEmoji]);

    const deadInMatch = mode !== EngineMode.Spectate && self !== null && !self.alive;

    return (
        <div ref={rootRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', fontFamily: HUD_FONT }}>
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
            <AlertStack theme={theme} alerts={hud.alerts} offsetTop={24} />

            {mode === EngineMode.Help && !compact && (
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
