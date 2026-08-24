import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RoomState, TilePhysics } from 'shared';
import { RoundBox } from '../components/common/RoundBox.tsx';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { EngineMode, SwitchGame, type HudState, type MapView, type SwitchEngine } from '../game';
import { gameSession } from '../game/GameSession.ts';
import { useGameSession } from '../game/useGameSession.ts';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { themeColors } from '../theme/color.ts';
import { resumeRoom } from '../api/rooms.ts';
import dashIcon from '../assets/images/skill_dash.webp';
import switchIcon from '../assets/images/skill_switch.webp';

interface RuntimeMapBundle {
    schemaVersion: number;
    mapBundleHash: string;
    simulationHz: number;
    tileSize: number;
    maps: Record<string, { size: number; initial_map: number[][] }>;
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');

async function verifiedMapView(mapId: string, expectedHash: string, gameOrigin: string): Promise<MapView> {
    const response = await fetch(`${gameOrigin}/map-bundles/${expectedHash}.json`, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`map bundle request failed (${response.status})`);
    const bundle = await response.json() as RuntimeMapBundle;
    if (bundle.mapBundleHash !== expectedHash || bundle.schemaVersion !== 1) throw new Error('map bundle identity mismatch');
    const unsigned = JSON.stringify({
        schemaVersion: bundle.schemaVersion,
        simulationHz: bundle.simulationHz,
        tileSize: bundle.tileSize,
        maps: bundle.maps,
    });
    const actualHash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(unsigned)));
    if (actualHash !== expectedHash) throw new Error('map bundle hash verification failed');
    const map = bundle.maps[mapId];
    if (!map || !Number.isInteger(map.size) || map.initial_map.length !== map.size) throw new Error(`unknown map: ${mapId}`);
    const validTiles = new Set<number>(Object.values(TilePhysics));
    if (map.initial_map.some((row) => row.length !== map.size || row.some((tile) => !validTiles.has(tile)))) {
        throw new Error('map tile data is malformed');
    }
    return { cols: map.size, rows: map.size, tiles: map.initial_map as MapView['tiles'] };
}

export const GamePage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const session = useGameSession();
    const theme = useSettingsStore((state) => state.theme);
    const engineRef = useRef<SwitchEngine | null>(null);
    const loadedMapId = useRef<string | null>(null);
    const mapReady = useRef(false);
    const pendingSnapshot = useRef<ArrayBuffer | null>(null);
    const [mapError, setMapError] = useState<string | null>(null);
    const [mapRetry, setMapRetry] = useState(0);
    const recoveryAttempted = useRef(false);
    const requestedRoomId = searchParams.get('room_id');
    const live = session.status === 'connected' && session.roomId !== null;
    const mapId = session.lobby?.mapId ?? null;
    const mapBundleHash = session.mapBundleHash;

    useEffect(() => {
        if (live || recoveryAttempted.current || !requestedRoomId || !/^[0-9a-f-]{36}$/i.test(requestedRoomId)) return;
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
    }, [live, navigate, requestedRoomId]);

    const loadMap = useCallback(async (engine: SwitchEngine, id: string, hash: string, gameOrigin: string) => {
        const key = `${hash}:${id}`;
        if (loadedMapId.current === key) return;
        mapReady.current = false;
        setMapError(null);
        try {
            const view = await verifiedMapView(id, hash, gameOrigin);
            if (engineRef.current !== engine) return;
            engine.map.load(view);
            loadedMapId.current = key;
            mapReady.current = true;
            const latest = pendingSnapshot.current ?? gameSession.getLatestSnapshot();
            pendingSnapshot.current = null;
            if (latest) engine.applySnapshot(latest);
        } catch (error) {
            setMapError(error instanceof Error ? error.message : String(error));
            console.error(`[swITch] failed to load map "${id}"`, error);
        }
    }, []);

    const handleEngine = useCallback((engine: SwitchEngine | null) => {
        engineRef.current = engine;
        loadedMapId.current = null;
        mapReady.current = false;
        if (!engine) return;
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
            engineRef.current?.applySnapshot(frame);
        } catch (error) {
            console.error('[swITch] snapshot apply failed', {
                roomId: gameSession.getSnapshot().roomId,
                selfId: gameSession.getSnapshot().selfId,
                byteLength: frame.byteLength,
                error,
            });
        }
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
                {mapError && (
                    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.65)', color: 'white', zIndex: 20 }}>
                        <div style={{ display: 'grid', gap: 20, justifyItems: 'center' }}>
                            <p>맵을 불러오지 못했습니다: {mapError}</p>
                            <RoundButton width={300} height={80} type={1} content={t('rooms.refresh')} onClick={() => setMapRetry((value) => value + 1)}/>
                            <RoundButton width={300} height={80} type={2} content={t('lobby.leave')} onClick={() => { gameSession.disconnect(); navigate('/rooms'); }}/>
                        </div>
                    </div>
                )}
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
