import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RoomState } from 'shared';
import { RoundBox } from '../components/common/RoundBox.tsx';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { EngineMode, SwitchGame, type HudState, type SwitchEngine } from '../game';
import { gameSession } from '../game/GameSession.ts';
import { useGameSession } from '../game/useGameSession.ts';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { themeColors } from '../theme/color.ts';
import dashIcon from '../assets/images/skill_dash.webp';
import switchIcon from '../assets/images/skill_switch.webp';

export const GamePage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const session = useGameSession();
    const theme = useSettingsStore((state) => state.theme);
    const engineRef = useRef<SwitchEngine | null>(null);
    const live = session.status === 'connected' && session.roomId !== null;

    const handleEngine = useCallback((engine: SwitchEngine | null) => {
        engineRef.current = engine;
        const latest = gameSession.getLatestSnapshot();
        if (engine && latest) engine.applySnapshot(latest);
    }, []);

    useEffect(() => gameSession.subscribeSnapshots((frame) => {
        try { engineRef.current?.applySnapshot(frame); } catch { /* a later full frame can recover */ }
    }), []);

    useEffect(() => {
        if (!session.ended || !session.roomId) return;
        const roomId = session.roomId;
        const timer = window.setTimeout(() => {
            navigate(`/rooms/${encodeURIComponent(roomId)}/lobby`, { replace: true });
        }, Math.max(0, session.ended.returnsAt - Date.now()));
        return () => window.clearTimeout(timer);
    }, [navigate, session.ended, session.roomId]);

    useEffect(() => {
        if (!live || session.roomState !== RoomState.Playing) return;
        const pressed = new Set<string>();
        const onKeyDown = (event: KeyboardEvent) => {
            pressed.add(event.code);
            const bindings = useSettingsStore.getState().keyBindings;
            if (Object.values(bindings).some((binding) => binding.includes(event.code))) event.preventDefault();
        };
        const onKeyUp = (event: KeyboardEvent) => pressed.delete(event.code);
        const onBlur = () => pressed.clear();
        let sequence = 0;
        const active = (action: 'moveUp' | 'moveDown' | 'moveLeft' | 'moveRight') =>
            useSettingsStore.getState().keyBindings[action].some((code) => code !== null && pressed.has(code));
        const timer = window.setInterval(() => {
            gameSession.sendInput({
                sequence: sequence++ & 0xffff,
                left: active('moveLeft'), right: active('moveRight'),
                up: active('moveUp'), down: active('moveDown'), heldActions: 0,
            });
        }, 1000 / 30);
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', onBlur);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('blur', onBlur);
        };
    }, [live, session.roomState]);

    const hud = useMemo<HudState>(() => ({
        players: (session.lobby?.players ?? []).map((player) => ({
            id: player.playerId,
            nickname: player.nickname,
            colorIndex: player.colorIndex,
            isTagger: player.playerId === session.started?.taggerId,
            alive: player.role === 'player',
        })),
        selfId: session.selfId,
        movementSkill: session.role === 'player' ? {
            id: 'movement', label: t('lobby.skills.dash'), iconUrl: dashIcon, key: 'Space', cooldown: 0, cooldownTotal: 0,
        } : null,
        switchSkill: session.role === 'player' ? {
            id: 'switch', label: 'swITch', iconUrl: switchIcon, key: '1–8', cooldown: 0, cooldownTotal: 0,
        } : null,
        switchTargets: [],
        elapsedSec: null,
        spectatingId: null,
        alerts: [],
    }), [session.lobby, session.role, session.selfId, session.started, t]);

    if (live) {
        return (
            <div style={{ position: 'absolute', inset: 0 }}>
                <SwitchGame
                    mode={session.role === 'spectator' ? EngineMode.Spectate : EngineMode.Play}
                    hud={hud}
                    onEngine={handleEngine}
                    onUseMovementSkill={() => gameSession.send({ type: 'game.useSkill', payload: { slot: 2 } })}
                    onEmoji={(emojiId) => gameSession.send({ type: 'game.emoji', payload: { emojiId } })}
                />
            </div>
        );
    }

    return (
        <PageLayout title="swITch" backTo="/rooms">
            <RoundBox x={960} y={535} width={1250} height={650} type={1}/>
            <div style={{ position: 'absolute', left: 960, top: 520, width: 900, transform: 'translate(-50%,-50%)', textAlign: 'center', display: 'grid', gap: 45, justifyItems: 'center' }}>
                <p style={{ color: themeColors(theme).text, fontSize: 43, lineHeight: 1.5, margin: 0 }}>{t('rooms.joinUnavailable')}</p>
                <p style={{ color: themeColors(theme).muted, fontSize: 27, lineHeight: 1.45, margin: 0 }}>{t('game.serverPending')}</p>
                <RoundButton width={600} height={108} type={1} content={t('guide.openSandbox')} onClick={() => navigate('/sandbox')}/>
            </div>
        </PageLayout>
    );
};
