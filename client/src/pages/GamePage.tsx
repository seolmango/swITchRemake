import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RoomState, SkillId, SkillSlot, isLoadoutSkill } from 'shared';
import { RoundBox } from '../components/common/RoundBox.tsx';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { EngineMode, SwitchGame, type HudState, type SwitchEngine } from '../game';
import { verifiedMapView } from '../game/mapBundle.ts';
import { gameSession } from '../game/GameSession.ts';
import { useGameSession } from '../game/useGameSession.ts';
import { type KeyAction, useSettingsStore } from '../stores/useSettingsStore.ts';
import { themeColors } from '../theme/color.ts';
import { resumeRoom } from '../api/rooms.ts';
import dashIcon from '../assets/images/skill_dash.svg';
import flashIcon from '../assets/images/skill_flash.svg';
import exhaustIcon from '../assets/images/skill_exhaust.svg';
import switchIcon from '../assets/images/skill_switch.svg';
import { formatKeyBindings, matchesKeyBinding } from '../utils/keyBinding.ts';
import { cooldownTotalMs, getSwitchTargets, skillRejectionMessageKey, toCooldownDisplay } from '../utils/skillHud.ts';
import { switchTargetPlayerIdForMatch } from '../utils/switchTarget.ts';
import { GameLoadingOverlay } from '../game/hud/GameLoadingOverlay.tsx';
import { isValidMatchId } from '../utils/matchId.ts';

const SKILL_PRESENTATION: Record<Exclude<SkillId, 'switch'>, { iconUrl: string; labelKey: string }> = {
    [SkillId.Dash]: { iconUrl: dashIcon, labelKey: 'lobby.skills.dash' },
    [SkillId.Flash]: { iconUrl: flashIcon, labelKey: 'lobby.skills.flash' },
    [SkillId.Exhaust]: { iconUrl: exhaustIcon, labelKey: 'lobby.skills.exhaust' },
};

const SWITCH_ACTIONS: readonly KeyAction[] = ['switch1', 'switch2', 'switch3', 'switch4', 'switch5', 'switch6', 'switch7', 'switch8'];
const EMOJI_ACTIONS: readonly KeyAction[] = ['emoji1', 'emoji2', 'emoji3', 'emoji4', 'emoji5', 'emoji6', 'emoji7', 'emoji8'];

function usePrefersReducedMotion(): boolean {
    const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
    useEffect(() => {
        const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        if (!media) return;
        const update = () => setReduced(media.matches);
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    return reduced;
}

export const GamePage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const session = useGameSession();
    const theme = useSettingsStore((state) => state.theme);
    const keyBindings = useSettingsStore((state) => state.keyBindings);
    const motionLevel = useSettingsStore((state) => state.motionLevel);
    const prefersReducedMotion = usePrefersReducedMotion();
    const engineRef = useRef<SwitchEngine | null>(null);
    const loadedMapId = useRef<string | null>(null);
    const mapReady = useRef(false);
    const pendingSnapshot = useRef<ArrayBuffer | null>(null);
    const [mapError, setMapError] = useState<string | null>(null);
    const [mapRetry, setMapRetry] = useState(0);
    const [engineReady, setEngineReady] = useState(false);
    const [mapLoaded, setMapLoaded] = useState(false);
    const [firstSnapshotApplied, setFirstSnapshotApplied] = useState(false);
    const [loadingTimedOut, setLoadingTimedOut] = useState(false);
    const recoveryAttempted = useRef(false);
    const requestedRoomId = searchParams.get('room_id');
    const live = session.status === 'connected' && session.roomId !== null;
    const gameVisible = live || (session.status === 'reconnecting' && session.roomId !== null && session.started !== null);
    const mapId = session.starting?.mapId ?? session.lobby?.mapId ?? null;
    const mapBundleHash = session.mapBundleHash;

    const applySnapshot = useCallback((engine: SwitchEngine, frame: ArrayBuffer) => {
        const simulationHz = gameSession.getSnapshot().starting?.gameplay.simulationHz;
        const snapshot = engine.applySnapshot(frame, simulationHz);
        gameSession.updateHudSnapshot(snapshot);
        const started = gameSession.getSnapshot().started;
        if (started && snapshot.tick >= started.startTick) setFirstSnapshotApplied(true);
    }, []);

    useEffect(() => {
        if (live || session.status === 'reconnecting' || session.roomId !== null || recoveryAttempted.current || !requestedRoomId || !/^[0-9a-f-]{36}$/i.test(requestedRoomId)) return;
        recoveryAttempted.current = true;
        void resumeRoom(requestedRoomId)
            .then((grant) => gameSession.connect(grant))
            .then(() => {
                const state = gameSession.getSnapshot();
                if (state.roomState !== RoomState.Playing) {
                    navigate(`/rooms/${encodeURIComponent(requestedRoomId)}/lobby`, { replace: true });
                }
            })
            .catch((error) => console.error('[swITch] game recovery failed', { roomId: requestedRoomId, error }));
    }, [live, navigate, requestedRoomId, session.roomId, session.status]);

    const loadMap = useCallback(async (engine: SwitchEngine, id: string, hash: string, gameOrigin: string) => {
        const key = `${hash}:${id}`;
        if (loadedMapId.current === key) return;
        mapReady.current = false;
        setMapError(null);
        try {
            const view = await verifiedMapView(id, hash, gameOrigin);
            if (engineRef.current !== engine) return;
            engine.map.load(view);
            await engine.whenReady();
            if (engineRef.current !== engine) return;
            loadedMapId.current = key;
            mapReady.current = true;
            setMapLoaded(true);
            const latest = pendingSnapshot.current ?? gameSession.getLatestSnapshot();
            pendingSnapshot.current = null;
            if (latest) applySnapshot(engine, latest);
        } catch (error) {
            setMapError(error instanceof Error ? error.message : String(error));
            console.error(`[swITch] failed to load map "${id}"`, error);
        }
    }, [applySnapshot]);

    const handleEngine = useCallback((engine: SwitchEngine | null) => {
        engineRef.current = engine;
        loadedMapId.current = null;
        mapReady.current = false;
        setEngineReady(false);
        setMapLoaded(false);
        setFirstSnapshotApplied(false);
        if (!engine) return;
        void engine.whenReady().then(() => {
            if (engineRef.current === engine) setEngineReady(true);
        });
        if (mapId && mapBundleHash && session.gameHttpOrigin) {
            void loadMap(engine, mapId, mapBundleHash, session.gameHttpOrigin);
        }
    }, [loadMap, mapBundleHash, mapId, session.gameHttpOrigin]);

    useEffect(() => {
        if (engineRef.current && mapId && mapBundleHash && session.gameHttpOrigin) {
            void loadMap(engineRef.current, mapId, mapBundleHash, session.gameHttpOrigin);
        }
    }, [loadMap, mapBundleHash, mapId, mapRetry, session.gameHttpOrigin]);

    useEffect(() => gameSession.subscribeSnapshots((frame) => {
        if (!mapReady.current) {
            pendingSnapshot.current = frame;
            return;
        }
        try {
            const engine = engineRef.current;
            if (engine) applySnapshot(engine, frame);
        } catch (error) {
            console.error('[swITch] snapshot apply failed', {
                roomId: gameSession.getSnapshot().roomId,
                selfId: gameSession.getSnapshot().selfId,
                byteLength: frame.byteLength,
                error,
            });
        }
    }), [applySnapshot]);

    useEffect(() => gameSession.subscribeBlinks(({ playerId, fromX, fromY }) => {
        engineRef.current?.applyPlayerBlinked(playerId, fromX, fromY);
    }), []);

    useEffect(() => gameSession.subscribeSkillAreas(({ skill, playerId, x, y, affectedPlayerId }) => {
        // 사거리는 서버가 game.starting으로 알려 준 값을 쓴다. 아직 못 받았으면 그리지 않는다 —
        // 임의의 반지름으로 그리면 "저 원 안이면 닿는다"는 잘못된 정보를 준다.
        const gameplay = gameSession.getSnapshot().starting?.gameplay;
        const rangePx = (skill === SkillId.Exhaust ? gameplay?.exhaustRangePx : gameplay?.switchRangePx) ?? 0;
        engineRef.current?.playSkillArea(playerId, x, y, affectedPlayerId, rangePx);
    }), []);

    useEffect(() => {
        if (!session.ended || !session.roomId) return;
        if (!isValidMatchId(session.ended.matchId)) {
            navigate(`/rooms/${encodeURIComponent(session.roomId)}/lobby`, { replace: true });
            return;
        }
        const query = new URLSearchParams({
            room_id: session.roomId,
            returns_at: String(session.ended.returnsAt),
        });
        navigate(`/matches/${encodeURIComponent(session.ended.matchId)}/result?${query.toString()}`, { replace: true });
    }, [navigate, session.ended, session.roomId]);

    const matchReady = engineReady && mapLoaded && session.started !== null && firstSnapshotApplied;
    useEffect(() => {
        if (matchReady) return;
        const timer = window.setTimeout(() => setLoadingTimedOut(true), 12_000);
        return () => window.clearTimeout(timer);
    }, [mapRetry, matchReady]);

    const waitingFor = !engineReady
        ? t('game.waitingRenderer')
        : !mapLoaded
            ? t('game.waitingMap')
            : session.started === null
                ? t('game.waitingStart')
                : t('game.waitingSnapshot');

    const exitGame = useCallback(() => {
        gameSession.disconnect();
        navigate('/rooms', { replace: true });
    }, [navigate]);

    const handleMovementSkill = useCallback(() => gameSession.send({ type: 'game.useSkill', payload: { slot: SkillSlot.Movement } }), []);
    const handleSwitchTarget = useCallback((targetPlayerId: number) => gameSession.send({
        type: 'game.useSkill', payload: { slot: SkillSlot.Switch, targetPlayerId },
    }), []);
    const handleEmoji = useCallback((emojiId: number) => gameSession.send({ type: 'game.emoji', payload: { emojiId } }), []);

    useEffect(() => {
        if (!live || session.roomState !== RoomState.Playing || session.role !== 'player') return;
        const pressed = new Set<string>();
        const onKeyDown = (event: KeyboardEvent) => {
            const alreadyPressed = pressed.has(event.code);
            pressed.add(event.code);
            const bindings = useSettingsStore.getState().keyBindings;
            const matches = (action: KeyAction) => bindings[action].some((binding) => matchesKeyBinding(event, binding));
            if (Object.values(bindings).some((binding) => binding.some((entry) => matchesKeyBinding(event, entry)))) event.preventDefault();
            if (event.repeat || alreadyPressed) return;

            if (matches('movementSkill')) {
                handleMovementSkill();
                return;
            }
            const switchTargetPlayerId = switchTargetPlayerIdForMatch(matches);
            if (switchTargetPlayerId !== null) {
                handleSwitchTarget(switchTargetPlayerId);
                return;
            }
            const emojiIndex = EMOJI_ACTIONS.findIndex(matches);
            if (emojiIndex >= 0) handleEmoji(emojiIndex);
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
    }, [handleEmoji, handleMovementSkill, handleSwitchTarget, live, session.role, session.roomState]);

    const hud = useMemo<HudState>(() => ({
        players: (session.lobby?.players ?? []).map((player) => ({
            id: player.playerId,
            nickname: player.nickname,
            colorIndex: player.colorIndex,
            isTagger: player.playerId === session.taggerId,
            alive: player.role === 'player',
        })),
        selfId: session.selfId,
        movementSkill: (() => {
            const skill = session.lobby?.players.find((player) => player.playerId === session.selfId)?.skills.find(
                (candidate): candidate is Exclude<SkillId, 'switch'> => isLoadoutSkill(candidate) && candidate !== SkillId.Switch,
            );
            if (session.role !== 'player' || !skill) return null;
            const presentation = SKILL_PRESENTATION[skill];
            const cooldown = toCooldownDisplay(session.cooldowns, SkillSlot.Movement, cooldownTotalMs(skill, session.starting?.gameplay));
            return {
                id: skill, label: t(presentation.labelKey), iconUrl: presentation.iconUrl,
                key: formatKeyBindings(keyBindings.movementSkill, t('game.noKeyBinding')),
                cooldown: cooldown.remainingMs / 1000, cooldownTotal: cooldown.totalMs / 1000,
                unavailable: !cooldown.available && cooldown.remainingMs === 0,
            };
        })(),
        switchSkill: (() => {
            if (session.role !== 'player') return null;
            const cooldown = toCooldownDisplay(session.cooldowns, SkillSlot.Switch, cooldownTotalMs(SkillId.Switch, session.starting?.gameplay));
            return {
                id: SkillId.Switch, label: 'swITch', iconUrl: switchIcon,
                key: formatKeyBindings(SWITCH_ACTIONS.flatMap((action) => keyBindings[action]), t('game.noKeyBinding')),
                cooldown: cooldown.remainingMs / 1000, cooldownTotal: cooldown.totalMs / 1000,
                unavailable: !cooldown.available && cooldown.remainingMs === 0,
            };
        })(),
        switchTargets: getSwitchTargets((session.lobby?.players ?? []).map((player) => ({
            id: player.playerId,
            alive: player.role === 'player',
            isTagger: player.playerId === session.taggerId,
        })), session.selfId),
        elapsedSec: null,
        spectatingId: null,
        alerts: session.skillRejections.map((rejection) => ({
            id: rejection.id,
            text: t(skillRejectionMessageKey(rejection.reason)),
            tone: 'danger' as const,
        })),
    }), [keyBindings, session.cooldowns, session.lobby, session.role, session.selfId, session.skillRejections, session.starting, session.taggerId, t]);

    if (gameVisible) {
        return (
            <div style={{ position: 'absolute', inset: 0 }}>
                <SwitchGame
                    mode={session.role === 'spectator' ? EngineMode.Spectate : EngineMode.Play}
                    hud={hud}
                    onEngine={handleEngine}
                    onUseMovementSkill={handleMovementSkill}
                    onSwitchTarget={handleSwitchTarget}
                    onEmoji={handleEmoji}
                    matchReady={matchReady}
                    latencyMs={session.latencyMs}
                    estimatedTps={session.estimatedTps}
                />
                <GameLoadingOverlay
                    theme={theme}
                    ready={matchReady}
                    reducedMotion={motionLevel === 'reduced' || prefersReducedMotion}
                    waitingFor={waitingFor}
                    mapError={mapError}
                    timedOut={loadingTimedOut}
                    onRetry={() => {
                        setLoadingTimedOut(false);
                        if (mapError) setMapRetry((value) => value + 1);
                        else window.location.reload();
                    }}
                    onExit={exitGame}
                />
                {session.status === 'reconnecting' && (
                    <div
                        role="status"
                        aria-live="polite"
                        style={{
                            position: 'absolute', top: 24, left: '50%', zIndex: 40, transform: 'translateX(-50%)',
                            padding: '14px 24px', borderRadius: 999, color: themeColors(theme).text,
                            background: themeColors(theme).panel, border: `2px solid ${themeColors(theme).panelBorder}`,
                            fontSize: 22, fontWeight: 800,
                        }}
                    >
                        {t('game.reconnecting')}
                    </div>
                )}
            </div>
        );
    }

    return (
        <PageLayout title="swITch" backTo="/rooms">
            <RoundBox x={960} y={535} width={1250} height={650} type={1}/>
            <div style={{ position: 'absolute', left: 960, top: 520, width: 900, transform: 'translate(-50%,-50%)', textAlign: 'center', display: 'grid', gap: 45, justifyItems: 'center' }}>
                <p style={{ color: themeColors(theme).text, fontSize: 43, lineHeight: 1.5, margin: 0 }}>{session.status === 'disconnected' ? t('game.connectionLost') : t('lobby.resumeFailed')}</p>
                <p style={{ color: themeColors(theme).muted, fontSize: 27, lineHeight: 1.45, margin: 0 }}>{t('game.serverPending')}</p>
                <RoundButton width={600} height={108} type={1} content={t('lobby.leave')} onClick={exitGame}/>
            </div>
        </PageLayout>
    );
};
