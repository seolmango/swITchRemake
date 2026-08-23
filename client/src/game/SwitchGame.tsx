import React, { useCallback, useState } from 'react';
import { GameCanvas } from './GameCanvas.tsx';
import { GameHud } from './hud/GameHud.tsx';
import { EMPTY_HUD, type HudState } from './hud/hudTypes.ts';
import { EngineMode } from './types.ts';
import type { SwitchEngine } from './SwitchEngine.ts';
import { useSettingsStore } from '../stores/useSettingsStore.ts';

export interface SwitchGameProps {
    mode?: EngineMode;
    /** Low-frequency HUD data (roster, cooldowns, alerts). Per-frame world state never comes through here. */
    hud?: HudState;
    /** Fires with the engine on mount, and with `null` right before teardown. */
    onEngine?: (engine: SwitchEngine | null) => void;
    /** The one equipped movement skill fired (Space or its button). */
    onUseMovementSkill?: () => void;
    /** Switch requested against a player, by number key or by clicking their roster row. */
    onSwitchTarget?: (playerId: number) => void;
    /** Spectate target picked. The camera is already moved for you; this is for anything else that cares. */
    onSpectate?: (playerId: number) => void;
    onEmoji?: (emojiId: number) => void;
}

/**
 * The single thing a page mounts: the Phaser world plus its screen-anchored React HUD, wired together.
 *
 * Keeping them in one component is what makes the split manageable — the alternative (a page assembling
 * `GameCanvas` and a HUD separately) leaves engine state and HUD state to be synchronised from two
 * directions. Here the engine handle flows out through one callback and HUD intent flows back in through
 * another, so a page only decides *what* to show and *what* a button means.
 */
export const SwitchGame: React.FC<SwitchGameProps> = ({
    mode = EngineMode.Play,
    hud = EMPTY_HUD,
    onEngine,
    onUseMovementSkill,
    onSwitchTarget,
    onSpectate,
    onEmoji,
}) => {
    const theme = useSettingsStore((s) => s.theme);
    const [engine, setEngine] = useState<SwitchEngine | null>(null);

    const handleEngine = useCallback((next: SwitchEngine | null) => {
        setEngine(next);
        onEngine?.(next);
    }, [onEngine]);

    /**
     * Spectate camera is handled here rather than pushed out to the page, because this component already
     * holds both the engine and the HUD — which is the concrete payoff of bundling them. Clicking a
     * roster row to watch someone is pure presentation; a page shouldn't have to wire it.
     */
    const handleSpectate = useCallback((playerId: number) => {
        engine?.camera.follow(playerId);
        onSpectate?.(playerId);
    }, [engine, onSpectate]);

    return (
        <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0 }}>
            <GameCanvas onEngine={handleEngine} mode={mode} />
            <GameHud
                theme={theme}
                mode={mode}
                hud={hud}
                onUseMovementSkill={() => onUseMovementSkill?.()}
                onSwitchTarget={(id) => onSwitchTarget?.(id)}
                onSpectate={handleSpectate}
                onEmoji={(id) => onEmoji?.(id)}
            />
        </div>
    );
};
