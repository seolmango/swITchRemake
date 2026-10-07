import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/common/Icon.tsx';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RoomState, SkillId, SkillSlot, isLoadoutSkill, trainingPadsFromMarkers } from 'shared';
import { RoundBox } from '../components/common/RoundBox.tsx';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { EngineMode, SwitchGame, type HudState, type SwitchEngine } from '../game';
import { verifiedMapView } from '../game/mapBundle.ts';
import { readTouchDirection } from '../game/touchInput.ts';
import { TILE_SIZE } from '../game/constants.ts';
import { gameSession } from '../game/GameSession.ts';
import { useGameSession } from '../game/useGameSession.ts';
import { EMOJI_ACTIONS, SWITCH_ACTIONS, type KeyAction, useSettingsStore } from '../stores/useSettingsStore.ts';
import { themeColors } from '../theme/color.ts';
import { resumeRoom } from '../api/rooms.ts';
import { useSkillIcons } from '../theme/skillIcons.ts';
import switchIcon from '../assets/images/skill_switch.svg';
import { formatKeyBindings, matchesHeldKeyBinding, matchesKeyBinding } from '../utils/keyBinding.ts';
import { cooldownTotalMs, getSwitchTargets, skillRejectionMessageKey, toCooldownDisplay } from '../utils/skillHud.ts';
import { switchTargetPlayerIdForMatch } from '../utils/switchTarget.ts';
import { GameLoadingOverlay } from '../game/hud/GameLoadingOverlay.tsx';
import { isValidMatchId } from '../utils/matchId.ts';
import type { MapView } from '../game/types.ts';
import type { TrainingPad } from 'shared';
import { SettingsPage } from './SettingsPage.tsx';
import { matchSfx, useMatchSfx } from '../audio/matchSfx.ts';
import { canEnterRunningGame } from '../game/roomRole.ts';
import { BufferedSnapshots } from '../game/BufferedSnapshots.ts';
import { useModalFocusTrap } from '../components/common/useModalFocusTrap.ts';
import { usePrefersReducedMotion } from '../platform/reducedMotion.ts';

const SKILL_PRESENTATION: Record<Exclude<SkillId, 'switch'>, { icon: 'dash' | 'flash' | 'exhaust'; labelKey: string }> = {
    [SkillId.Dash]: { icon: 'dash', labelKey: 'lobby.skills.dash' },
    [SkillId.Flash]: { icon: 'flash', labelKey: 'lobby.skills.flash' },
    [SkillId.Exhaust]: { icon: 'exhaust', labelKey: 'lobby.skills.exhaust' },
};

export const GamePage: React.FC<{ training?: boolean }> = ({ training = false }) => {
    const skillIcons = useSkillIcons();
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
    const pendingSnapshots = useRef(new BufferedSnapshots());
    const [mapError, setMapError] = useState<string | null>(null);
    const [mapRetry, setMapRetry] = useState(0);
    const [engineReady, setEngineReady] = useState(false);
    const [mapLoaded, setMapLoaded] = useState(false);
    const [firstSnapshotApplied, setFirstSnapshotApplied] = useState(false);
    const [loadingTimedOut, setLoadingTimedOut] = useState(false);
    const recoveryAttempted = useRef(false);
    const inputSequence = useRef(0);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const { dialogRef: settingsDialogRef, onDialogKeyDown: onSettingsDialogKeyDown } = useModalFocusTrap<HTMLDivElement>(
        () => setSettingsOpen(false), settingsOpen,
    );
    const [trainingMap, setTrainingMap] = useState<MapView | null>(null);
    const [trainingPads, setTrainingPads] = useState<readonly TrainingPad[]>([]);
    const [spectatingId, setSpectatingId] = useState<number | null>(null);
    const nextInputSequence = useCallback(() => inputSequence.current++ & 0xffff, []);
    const requestedRoomId = searchParams.get('room_id');
    const live = session.status === 'connected' && session.roomId !== null;
    const mayEnterGame = training || canEnterRunningGame(session.role);
    const gameVisible = mayEnterGame && (live || (session.status === 'reconnecting' && session.roomId !== null && session.started !== null));
    const mapId = session.starting?.mapId ?? session.lobby?.mapId ?? null;
    const mapBundleHash = session.mapBundleHash;

    useMatchSfx();

    const applySnapshot = useCallback((engine: SwitchEngine, frame: ArrayBuffer) => {
        const simulationHz = gameSession.getSnapshot().starting?.gameplay.simulationHz;
        const snapshot = engine.applySnapshot(frame, simulationHz);
        gameSession.updateHudSnapshot(snapshot);
        // 소리는 이미 디코드된 것에서 뽑는다. 오디오를 위해 프레임을 한 번 더 풀지 않는다.
        matchSfx.onSnapshot(snapshot, gameSession.getSnapshot().selfId);
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
                if (state.roomState !== RoomState.Playing || !canEnterRunningGame(state.role)) {
                    navigate(`/rooms/${encodeURIComponent(requestedRoomId)}/lobby`, { replace: true });
                }
            })
            .catch((error) => console.error('[swITch] game recovery failed', { roomId: requestedRoomId, error }));
    }, [live, navigate, requestedRoomId, session.roomId, session.status]);

    useEffect(() => {
        if (training || !live || session.role !== 'waiting' || !session.roomId) return;
        navigate(`/rooms/${encodeURIComponent(session.roomId)}/lobby`, { replace: true });
    }, [live, navigate, session.role, session.roomId, training]);

    const loadMap = useCallback(async (engine: SwitchEngine, id: string, hash: string, gameOrigin: string) => {
        const key = `${hash}:${id}`;
        if (loadedMapId.current === key) return;
        mapReady.current = false;
        setMapError(null);
        try {
            const { view, markers } = await verifiedMapView(id, hash, gameOrigin);
            if (engineRef.current !== engine) return;
            engine.map.load(view);
            // 패드는 맵과 같은 번들에서 온다. 별도 메시지로 받으면 두 경로가 갈라질 자리가 생긴다.
            const pads = trainingPadsFromMarkers(markers, TILE_SIZE);
            setTrainingMap(view);
            setTrainingPads(pads);
            engine.setTrainingPads(pads);
            gameSession.setTrainingPads(pads);
            await engine.whenReady();
            if (engineRef.current !== engine) return;
            loadedMapId.current = key;
            mapReady.current = true;
            setMapLoaded(true);
            const latest = pendingSnapshots.current.take() ?? gameSession.getLatestSnapshot();
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
        if (!training) return;
        if (session.role === 'spectator') engineRef.current?.camera.free();
        else if (session.role === 'player' && session.selfId !== null) engineRef.current?.camera.follow(session.selfId);
    }, [session.role, session.selfId, training, engineReady]);

    useEffect(() => {
        if (engineRef.current && mapId && mapBundleHash && session.gameHttpOrigin) {
            void loadMap(engineRef.current, mapId, mapBundleHash, session.gameHttpOrigin);
        }
    }, [loadMap, mapBundleHash, mapId, mapRetry, session.gameHttpOrigin]);

    useEffect(() => gameSession.subscribeSnapshots((frame) => {
        if (!mapReady.current) {
            pendingSnapshots.current.push(frame);
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

    useEffect(() => gameSession.subscribeSkillAreas(({ skill, playerId, x, y, targetPlayerId }) => {
        // 사거리는 서버가 game.starting으로 알려 준 값을 쓴다. 아직 못 받았으면 그리지 않는다 —
        // 임의의 반지름으로 그리면 "저 원 안이면 닿는다"는 잘못된 정보를 준다.
        const gameplay = gameSession.getSnapshot().starting?.gameplay;
        const rangePx = (skill === SkillId.Exhaust ? gameplay?.exhaustRangePx : gameplay?.switchRangePx) ?? 0;
        engineRef.current?.playSkillArea(playerId, x, y, targetPlayerId, rangePx);
    }), []);

    useEffect(() => {
        if (training || !session.ended || !session.roomId) return;
        if (!isValidMatchId(session.ended.matchId)) {
            navigate(`/rooms/${encodeURIComponent(session.roomId)}/lobby`, { replace: true });
            return;
        }
        const query = new URLSearchParams({
            room_id: session.roomId,
            returns_at: String(session.ended.returnsAt),
        });
        navigate(`/matches/${encodeURIComponent(session.ended.matchId)}/result?${query.toString()}`, { replace: true });
    }, [navigate, session.ended, session.roomId, training]);

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
        gameSession.send({ type: 'lobby.leave', payload: {} });
        gameSession.disconnect();
        navigate(training ? '/how-to-play' : '/rooms', { replace: true });
    }, [navigate, training]);

    const handleMovementSkill = useCallback(() => gameSession.send({ type: 'game.useSkill', payload: { slot: SkillSlot.Movement } }), []);
    const handleSwitchTarget = useCallback((targetPlayerId: number) => gameSession.send({
        type: 'game.useSkill', payload: { slot: SkillSlot.Switch, targetPlayerId },
    }), []);
    const handleEmoji = useCallback((emojiId: number) => gameSession.send({ type: 'game.emoji', payload: { emojiId } }), []);

    useEffect(() => {
        if (!live || session.roomState !== RoomState.Playing || session.role !== 'player' || settingsOpen) return;
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
            if (emojiIndex >= 0) handleEmoji(emojiIndex + 1);
        };
        const onKeyUp = (event: KeyboardEvent) => pressed.delete(event.code);
        const onBlur = () => pressed.clear();
        const movementActions = ['moveUp', 'moveDown', 'moveLeft', 'moveRight'] as const;
        const active = (action: (typeof movementActions)[number]) => {
            const bindings = useSettingsStore.getState().keyBindings;
            const alternatives = movementActions.flatMap(direction => bindings[direction]);
            return bindings[action].some(binding => matchesHeldKeyBinding(pressed, binding, alternatives));
        };
        const timer = window.setInterval(() => {
            // 키보드와 조이스틱을 합친다. 한쪽이 다른 쪽을 끄면 태블릿에 키보드를 붙인 사람처럼
            // 둘 다 쓰는 조합에서 조작이 죽는다. 조이스틱을 안 잡고 있으면 전부 false다.
            const touch = readTouchDirection();
            gameSession.sendInput({
                sequence: nextInputSequence(),
                left: active('moveLeft') || touch.left,
                right: active('moveRight') || touch.right,
                up: active('moveUp') || touch.up,
                down: active('moveDown') || touch.down,
                heldActions: 0,
            });
        }, 1000 / 30);
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', onBlur);
        return () => {
            window.clearInterval(timer);
            gameSession.sendInput({
                sequence: nextInputSequence(),
                left: false, right: false, up: false, down: false, heldActions: 0,
            });
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('blur', onBlur);
        };
    }, [handleEmoji, handleMovementSkill, handleSwitchTarget, live, nextInputSequence, session.role, session.roomState, settingsOpen]);

    const hudPlayers = training && session.trainingPlayers.length > 0
        ? session.trainingPlayers
        : (session.lobby?.players ?? []).map((player) => ({
            id: player.playerId,
            nickname: player.nickname,
            colorIndex: player.colorIndex,
            isTagger: player.playerId === session.taggerId,
            alive: player.role === 'player',
        }));

    const hud = useMemo<HudState>(() => ({
        players: hudPlayers,
        selfId: session.selfId,
        movementSkill: (() => {
            const skill = session.trainingSkill ?? session.lobby?.players.find((player) => player.playerId === session.selfId)?.skills.find(
                (candidate): candidate is Exclude<SkillId, 'switch'> => isLoadoutSkill(candidate) && candidate !== SkillId.Switch,
            );
            if (session.role !== 'player' || !skill) return null;
            const presentation = SKILL_PRESENTATION[skill];
            const cooldown = toCooldownDisplay(session.cooldowns, SkillSlot.Movement, cooldownTotalMs(skill, session.starting?.gameplay));
            return {
                id: skill, label: t(presentation.labelKey), iconUrl: skillIcons[presentation.icon],
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
        switchTargets: getSwitchTargets(hudPlayers, session.selfId),
        elapsedSec: null,
        // 훈련장은 탈락해도 자유 카메라를 쓴다. 이전 실경기의 관전 대상 상태는 표시하지 않는다.
        spectatingId: training ? null : spectatingId,
        alerts: session.skillRejections.map((rejection) => ({
            id: rejection.id,
            text: t(skillRejectionMessageKey(rejection.reason, training)),
            tone: 'danger' as const,
        })),
    }), [hudPlayers, keyBindings, session.cooldowns, session.lobby, session.role, session.selfId, session.skillRejections, session.starting, session.trainingSkill, skillIcons, spectatingId, t, training]);

    const selfAlive = hudPlayers.find((player) => player.id === session.selfId)?.alive ?? false;

    if (gameVisible) {
        const colors = themeColors(theme);
        return (
            <div style={{
                position: 'absolute', inset: 0,
                '--training-panel': colors.panel,
                '--training-border': colors.panelBorder,
                '--training-text': colors.text,
                '--training-backdrop': colors.backdrop,
            } as React.CSSProperties}>
                <SwitchGame
                    mode={session.role === 'spectator' ? EngineMode.Spectate : EngineMode.Play}
                    hud={hud}
                    onEngine={handleEngine}
                    onUseMovementSkill={handleMovementSkill}
                    onSwitchTarget={handleSwitchTarget}
                    onEmoji={handleEmoji}
                    onSpectate={setSpectatingId}
                    matchReady={matchReady}
                    inputEnabled={!settingsOpen}
                    latencyMs={session.latencyMs}
                    estimatedTps={session.estimatedTps}
                    suggestLandscape
                    trainingHud={training && matchReady ? {
                        map: trainingMap, pads: trainingPads, selfId: session.selfId, alive: selfAlive,
                        isTagger: hudPlayers.find((player) => player.id === session.selfId)?.isTagger ?? false,
                        movementSkillLabel: hud.movementSkill?.label ?? null,
                        onSettings: () => setSettingsOpen(true), onExit: exitGame,
                        onRespawn: () => gameSession.send({ type: 'training.respawn', payload: {} }),
                    } : undefined}
                />
                {training && matchReady && (
                    <>
                        {settingsOpen && (
                            <div ref={settingsDialogRef} className="training-settings-overlay" role="dialog" aria-modal="true" aria-label={t('settings.title')} tabIndex={-1} onKeyDown={onSettingsDialogKeyDown}>
                                {/* 다른 화면의 "뒤로"와 같은 자리·모양. 예전의 아래쪽 글자 버튼은 잘 안 보여서 이것으로 바꿨다 —
                                    같은 이름의 닫기 버튼을 둘 두면 스크린리더가 두 번 읽는다. */}
                                <RoundButton x={56} y={58} width={88} height={88} type={2} content={<Icon name="close"/>} ariaLabel={t('training.closeSettings')} onClick={() => setSettingsOpen(false)}/>
                                <SettingsPage embedded />
                            </div>
                        )}
                    </>
                )}
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
                            padding: '14px 24px', borderRadius: 'var(--radius-sm)', color: themeColors(theme).text,
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
        <PageLayout title="swITch" backTo={training ? '/how-to-play' : '/rooms'}>
            <RoundBox x={960} y={535} width={1250} height={650} type={1}/>
            <div style={{ position: 'absolute', left: 960, top: 520, width: 900, transform: 'translate(-50%,-50%)', textAlign: 'center', display: 'grid', gap: 45, justifyItems: 'center' }}>
                <p style={{ color: themeColors(theme).text, fontSize: 43, lineHeight: 1.5, margin: 0 }}>{session.status === 'disconnected' ? t('game.connectionLost') : t('lobby.resumeFailed')}</p>
                <p style={{ color: themeColors(theme).muted, fontSize: 27, lineHeight: 1.45, margin: 0 }}>{t('game.serverPending')}</p>
                <RoundButton width={600} height={108} type={1} content={t('lobby.leave')} onClick={exitGame}/>
            </div>
        </PageLayout>
    );
};
