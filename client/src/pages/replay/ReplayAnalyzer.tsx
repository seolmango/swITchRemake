import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { decodeSnapshot, encodeSnapshot, SKILL_TUNING, TILE_PX, type RecordedFrame, type ReplayManifest } from 'shared';
import { SwitchGame } from '../../game/SwitchGame.tsx';
import { EngineMode, type SwitchEngine } from '../../game/index.ts';
import { verifiedMapView } from '../../game/mapBundle.ts';
import type { MapView } from '../../game/types.ts';
import { EMPTY_HUD, type HudState } from '../../game/hud/hudTypes.ts';
import { Icon } from '../../components/common/Icon.tsx';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { userColorsFor } from '../../theme/cvd.ts';
import { Color } from '../../theme/color.ts';
import { frameBuffer } from '../../replay/replayFile.ts';
import { formatReplayTime, type AnalysisEvent, type ReplayAnalysis } from '../../replay/analysis.ts';
import { startVisibilityPausedInterval } from '../../utils/visibilityTimer.ts';
import { ReplayTimeline } from './ReplayTimeline.tsx';
import { ReplayPlayersPanel } from './ReplayPlayersPanel.tsx';
import { ReplayEventList } from './ReplayEventList.tsx';
import { ReplayPathMap } from './ReplayPathMap.tsx';
import type { ParticipantInfo } from './replayText.ts';
import './replay.css';

const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
/** 사건을 누르면 이만큼 앞에서 시작한다. 장면이 만들어지는 과정이 사건 자체보다 중요하다. */
const EVENT_LEAD_SECONDS = 1.5;
/** 이 이상 건너뛰면 앞 keyframe부터 다시 그린다. 그 아래는 이어서 그리는 편이 싸다. */
const MAX_INCREMENTAL_FRAMES = 12;
/**
 * 따라갈 때 경기 화면과 같은 넓이의 세상을 보여 준다. 경기는 1920×1080 화면을 줌 1로 채우므로,
 * 그보다 작은 무대에서는 그만큼 줌을 낮춰야 "그 사람이 본 범위"가 된다.
 */
const PLAY_VIEW = { width: 1920, height: 1080 };

type SideTab = 'players' | 'events' | 'paths';

interface ReplayAnalyzerProps {
    manifest: ReplayManifest;
    frames: readonly RecordedFrame[];
    analysis: ReplayAnalysis;
    /** 맵 번들을 받을 인게임 서버 주소. */
    gameOrigin: string;
    /** 받아 둔 파일을 저장하는 버튼 자리. 서버에서 바로 연 경우에만 있다. */
    saveSlot?: React.ReactNode;
}

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement
    && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export const ReplayAnalyzer: React.FC<ReplayAnalyzerProps> = ({ manifest, frames, analysis, gameOrigin, saveSlot }) => {
    const { t } = useTranslation();
    const theme = useSettingsStore((state) => state.theme);
    const colorVision = useSettingsStore((state) => state.colorVisionMode);
    const [engine, setEngine] = useState<SwitchEngine | null>(null);
    const engineRef = useRef<SwitchEngine | null>(null);
    const [simulationHz, setSimulationHz] = useState<number | null>(null);
    const [mapView, setMapView] = useState<MapView | null>(null);
    const [mapError, setMapError] = useState<string | null>(null);
    const [position, setPosition] = useState(0);
    const positionRef = useRef(0);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState<number>(1);
    const [focusId, setFocusId] = useState<number | null>(null);
    const focusRef = useRef<number | null>(null);
    useEffect(() => { focusRef.current = focusId; }, [focusId]);
    const [povId, setPovId] = useState<number | null>(null);
    const [sideTab, setSideTab] = useState<SideTab>('players');
    /** 엔진에 마지막으로 그린 프레임. -1이면 다음 그리기는 keyframe부터 다시 한다. */
    const appliedRef = useRef(-1);
    const mapReady = useRef(false);
    const stageRef = useRef<HTMLDivElement>(null);
    const lastFrame = Math.max(0, frames.length - 1);
    const startTick = analysis.ticks[0] ?? manifest.startTick;

    const participants = useMemo(() => new Map<number, ParticipantInfo>(manifest.participants.map((p) => {
        const [fill, stroke] = userColorsFor(p.colorIndex % Color.user.length, colorVision);
        return [p.playerId, { id: p.playerId, nickname: p.nickname, guest: p.guest, fill, stroke }];
    })), [manifest.participants, colorVision]);

    const ranges = useMemo(() => ({
        exhaust: SKILL_TUNING.EXHAUST_RANGE_TILES * TILE_PX,
        switch: SKILL_TUNING.SWITCH_RANGE_TILES * TILE_PX,
    }), []);

    const seek = useCallback((frameIndex: number) => {
        const next = Math.max(0, Math.min(lastFrame, Math.round(frameIndex)));
        positionRef.current = next;
        setPosition(next);
    }, [lastFrame]);

    // ── 엔진에 프레임 그리기 ──

    /**
     * 시점 모드면 그 사람이 그때 볼 수 있던 사람만 남긴다. 녹화가 프레임마다 사람별 시야를 남겨 두었으므로
     * 다시 계산하지 않는다 — 다시 계산하면 규칙이 바뀐 뒤의 시야가 나온다.
     */
    const bufferFor = useCallback((index: number): ArrayBuffer => {
        const buffer = frameBuffer(frames[index]!);
        if (povId === null) return buffer;
        const visible = analysis.visibleTo(povId, index);
        if (!visible) return buffer;
        const snapshot = decodeSnapshot(buffer);
        if (!snapshot.players) return buffer;
        return encodeSnapshot({ ...snapshot, players: snapshot.players.filter((p) => visible.has(p.id)) });
    }, [frames, analysis, povId]);

    const playEffects = useCallback((target: SwitchEngine, frameIndex: number, phase: 'before' | 'after') => {
        const visible = povId === null ? null : analysis.visibleTo(povId, frameIndex);
        for (const event of analysis.events) {
            if (event.frameIndex !== frameIndex) continue;
            if (visible && !visible.has(event.actorId)) continue;
            if (event.x === undefined || event.y === undefined) continue;
            if (phase === 'before' && event.kind === 'flash') target.applyPlayerBlinked(event.actorId, event.x, event.y);
            if (phase === 'after' && (event.kind === 'switch' || event.kind === 'switchMiss')) {
                target.playSkillArea(event.actorId, event.x, event.y, event.targetId ?? null, ranges.switch);
            }
            if (phase === 'after' && event.kind === 'exhaust') target.playSkillArea(event.actorId, event.x, event.y, null, ranges.exhaust);
        }
    }, [analysis, povId, ranges]);

    const drawUpTo = useCallback((target: number, withEffects: boolean) => {
        const current = engineRef.current;
        if (!current || !mapReady.current || simulationHz === null || frames.length === 0) return;
        const applied = appliedRef.current;
        if (applied >= 0 && target > applied && target - applied <= MAX_INCREMENTAL_FRAMES) {
            for (let i = applied + 1; i <= target; i++) {
                if (withEffects) playEffects(current, i, 'before');
                current.applySnapshot(bufferFor(i), simulationHz);
                if (withEffects) playEffects(current, i, 'after');
            }
        } else if (target !== applied) {
            // 델타 프레임이라 아무 데서나 시작할 수 없다. 앞선 full 프레임부터 훑어 와야 그 tick이 완성된다.
            let start = target;
            while (start > 0 && !frames[start]!.full) start -= 1;
            for (let i = start; i <= target; i++) current.applySnapshot(bufferFor(i), simulationHz);
            // 멀리 건너뛰었으면 카메라도 바로 옮긴다. 따라가기의 부드러운 이동으로 맵을 가로지르면 장면을 놓친다.
            const focus = focusRef.current;
            const sample = focus === null ? undefined : analysis.states[target]?.players.find((p) => p.id === focus);
            if (focus !== null && sample) {
                current.camera.centerOn(sample.x, sample.y);
                // Phaser의 따라가기는 붙는 순간 그 스프라이트의 **지금 그려진** 자리로 건너뛴다. 스프라이트는
                // 다음 엔진 프레임에야 새 자리로 가므로, 한 프레임 뒤에 붙여야 옛 자리로 되돌아가지 않는다.
                window.setTimeout(() => {
                    if (engineRef.current === current && focusRef.current === focus) current.camera.follow(focus);
                }, 50);
            }
        }
        appliedRef.current = target;
    }, [frames, simulationHz, bufferFor, playEffects, analysis]);

    useEffect(() => { drawUpTo(position, playing && speed <= 2); }, [position, drawUpTo, playing, speed]);

    // 시점이 바뀌면 지금 프레임을 처음부터 다시 그린다. 안 보이던 사람이 나타나거나 사라져야 한다.
    // 그리기 함수가 바뀔 때마다(맵 준비, 배속) 다시 그리면 헛일이라 시점이 바뀔 때만 돈다.
    const drawRef = useRef(drawUpTo);
    useEffect(() => { drawRef.current = drawUpTo; }, [drawUpTo]);
    useEffect(() => {
        appliedRef.current = -1;
        engineRef.current?.setSelf(povId);
        drawRef.current(positionRef.current, false);
    }, [povId]);

    // ── 카메라 ──
    useEffect(() => {
        if (!engine || simulationHz === null) return;
        if (focusId === null) {
            engine.camera.fitMap(64);
        } else {
            const stage = stageRef.current;
            const zoom = stage ? Math.min(stage.clientWidth / PLAY_VIEW.width, stage.clientHeight / PLAY_VIEW.height) : 1;
            engine.camera.setZoom(zoom > 0 ? zoom : 1);
            engine.camera.follow(focusId);
        }
    }, [engine, focusId, simulationHz]);

    const handleEngine = useCallback((next: SwitchEngine | null) => {
        engineRef.current = next;
        mapReady.current = false;
        appliedRef.current = -1;
        setEngine(next);
    }, []);

    // 맵은 manifest의 해시로 받는다. 그때 쓰던 번들을 그대로 가져오므로 규칙이 바뀐 뒤에도
    // 그 경기의 지형이 나온다. 서버가 그 번들을 더 이상 안 갖고 있으면 재생할 수 없다.
    useEffect(() => {
        if (!engine) return;
        let cancelled = false;
        void (async () => {
            try {
                const { view, simulationHz: mapHz } = await verifiedMapView(manifest.mapId, manifest.mapBundleHash, gameOrigin);
                if (cancelled || engineRef.current !== engine) return;
                engine.map.load(view);
                setMapView(view);
                await engine.whenReady();
                if (cancelled || engineRef.current !== engine) return;
                mapReady.current = true;
                appliedRef.current = -1;
                engine.camera.fitMap(64);
                setSimulationHz(mapHz);
            } catch (error) {
                if (!cancelled) setMapError(error instanceof Error ? error.message : String(error));
            }
        })();
        return () => { cancelled = true; };
    }, [engine, manifest.mapId, manifest.mapBundleHash, gameOrigin]);

    // ── 재생 시계 ──
    // 벽시계 × 배속으로 tick을 정하고 그 tick의 프레임을 고른다. 4배속에서 프레임을 건너뛰어도 시간이 맞는다.
    // 숨겨진 동안의 벽시계는 재생 위치가 아니다. 돌아왔을 때 큰 간격은 잘라서 멈춘 자리에서 잇는다.
    useEffect(() => {
        if (!playing || simulationHz === null) return;
        let last = performance.now();
        let tick = analysis.states[positionRef.current]?.tick ?? startTick;
        let shown = positionRef.current;
        return startVisibilityPausedInterval(() => {
            const now = performance.now();
            const elapsed = Math.min(250, now - last);
            last = now;
            // 재생 중에 ±5초나 사건으로 옮겼으면 그 자리에서 잇는다.
            if (positionRef.current !== shown) tick = analysis.states[positionRef.current]?.tick ?? tick;
            tick += elapsed / 1000 * simulationHz * speed;
            const next = analysis.frameAtTick(tick);
            if (next !== positionRef.current) seek(next);
            shown = next;
            if (next >= lastFrame) { setPlaying(false); return false; }
            return true;
        }, 1000 / 60);
    }, [playing, simulationHz, speed, analysis, lastFrame, seek, startTick]);

    const togglePlay = useCallback(() => {
        setPlaying((value) => {
            // 끝에서 누르면 처음부터. 끝에 멈춘 채 "재생"이 아무것도 안 하면 고장 난 것처럼 보인다.
            if (!value && positionRef.current >= lastFrame) seek(0);
            return !value;
        });
    }, [lastFrame, seek]);

    const seekSeconds = useCallback((seconds: number) => {
        if (simulationHz === null) return;
        const tick = (analysis.states[positionRef.current]?.tick ?? startTick) + seconds * simulationHz;
        seek(analysis.frameAtTick(tick));
    }, [analysis, simulationHz, seek, startTick]);

    const jumpToEvent = useCallback((event: AnalysisEvent) => {
        setPlaying(false);
        const lead = simulationHz === null ? 0 : EVENT_LEAD_SECONDS * simulationHz;
        seek(analysis.frameAtTick(event.tick - lead));
        if (focusId === null) setFocusId(event.kind === 'elimination' ? (event.targetId ?? event.actorId) : event.actorId);
    }, [analysis, simulationHz, seek, focusId]);

    const adjacentEvent = useCallback((direction: 1 | -1) => {
        const currentTick = analysis.states[positionRef.current]?.tick ?? startTick;
        const pool = analysis.events.filter((event) => event.kind === 'elimination' || event.kind === 'switch'
            || (focusId !== null && (event.actorId === focusId || event.targetId === focusId)));
        const lead = simulationHz === null ? 0 : EVENT_LEAD_SECONDS * simulationHz;
        // 사건 "앞"으로 가므로, 지금 위치가 이미 어떤 사건의 앞부분이면 그 사건은 지난 것으로 본다.
        const target = direction > 0
            ? pool.find((event) => event.tick - lead > currentTick + 1)
            : [...pool].reverse().find((event) => event.tick - lead < currentTick - 1);
        if (target) jumpToEvent(target);
    }, [analysis, focusId, jumpToEvent, simulationHz, startTick]);

    const changePov = useCallback((id: number | null) => {
        setPovId(id);
        if (id !== null) setFocusId(id);
    }, []);

    const changeFocus = useCallback((id: number | null) => {
        setFocusId(id);
        // 다른 사람을 고르면 시점도 그 사람으로 옮긴다. 시점을 켠 채 남을 따라가면 무엇을 보는지 헷갈린다.
        setPovId((current) => (current === null ? null : id));
    }, []);

    // ── 단축키 ──
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
            const frameStep = (direction: number) => { setPlaying(false); seek(positionRef.current + direction); };
            const handled = (() => {
                switch (event.key) {
                    case ' ': case 'k': case 'K': togglePlay(); return true;
                    case 'ArrowLeft': if (event.shiftKey) seekSeconds(-5); else frameStep(-1); return true;
                    case 'ArrowRight': if (event.shiftKey) seekSeconds(5); else frameStep(1); return true;
                    case 'j': case 'J': seekSeconds(-5); return true;
                    case 'l': case 'L': seekSeconds(5); return true;
                    case '[': adjacentEvent(-1); return true;
                    case ']': adjacentEvent(1); return true;
                    case '-': case '_': setSpeed((s) => REPLAY_SPEEDS[Math.max(0, REPLAY_SPEEDS.indexOf(s as typeof REPLAY_SPEEDS[number]) - 1)]!); return true;
                    case '=': case '+': setSpeed((s) => REPLAY_SPEEDS[Math.min(REPLAY_SPEEDS.length - 1, REPLAY_SPEEDS.indexOf(s as typeof REPLAY_SPEEDS[number]) + 1)]!); return true;
                    case 'v': case 'V': changePov(povId === null ? focusId : null); return true;
                    case '0': case 'Escape': changeFocus(null); return true;
                    case 'Home': seek(0); return true;
                    case 'End': seek(lastFrame); return true;
                    default: {
                        const digit = Number(event.key);
                        const id = Number.isInteger(digit) && digit >= 1 ? analysis.participantIds[digit - 1] : undefined;
                        if (id === undefined) return false;
                        changeFocus(focusId === id ? null : id);
                        return true;
                    }
                }
            })();
            if (handled) event.preventDefault();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [togglePlay, seekSeconds, adjacentEvent, changePov, changeFocus, povId, focusId, seek, lastFrame, analysis.participantIds]);

    // ── HUD ──
    const hud = useMemo<HudState>(() => {
        const state = analysis.states[position];
        if (!state) return EMPTY_HUD;
        const living = new Map(state.players.map((player) => [player.id, player]));
        return {
            ...EMPTY_HUD,
            players: manifest.participants.map((player) => ({
                id: player.playerId, nickname: player.nickname, colorIndex: player.colorIndex,
                alive: living.has(player.playerId), isTagger: living.get(player.playerId)?.isTagger ?? false,
            })),
            elapsedSec: simulationHz === null ? null : (state.tick - startTick) / simulationHz,
            spectatingId: focusId,
        };
    }, [analysis, manifest.participants, position, simulationHz, startTick, focusId]);

    const currentTick = analysis.states[position]?.tick ?? startTick;
    const endTick = analysis.ticks.at(-1) ?? startTick;
    const povName = povId === null ? null : participants.get(povId)?.nickname ?? `#${povId}`;
    const povLost = povId !== null && analysis.visibleTo(povId, position) === null;

    return (
        <div className="replay-analyzer">
            <div className="replay-main">
                <div className="replay-stage" ref={stageRef}>
                    <SwitchGame mode={EngineMode.Spectate} onEngine={handleEngine} hud={hud} onSpectate={changeFocus} matchReady/>
                    {povName && (
                        <p className="replay-pov-banner" role="status">
                            {t(povLost ? 'replay.analysis.povEliminated' : 'replay.analysis.povBanner', { name: povName })}
                            <button type="button" onClick={() => changePov(null)}>{t('replay.analysis.povExit')}</button>
                        </p>
                    )}
                    {mapError && <p className="replay-error" role="alert">{t('replay.mapFailed')}<small>{mapError}</small></p>}
                </div>

                <aside className="replay-side" aria-label={t('replay.analysis.panel')}>
                    <div className="replay-segmented replay-tabs" role="tablist">
                        {(['players', 'events', 'paths'] as const).map((tab) => (
                            <button key={tab} type="button" role="tab" aria-selected={sideTab === tab} onClick={() => setSideTab(tab)}>
                                {t(`replay.analysis.tab.${tab}`)}
                            </button>
                        ))}
                    </div>
                    <div className="replay-side-body" role="tabpanel">
                        {sideTab === 'players' && (
                            <ReplayPlayersPanel
                                analysis={analysis} position={position} simulationHz={simulationHz} participants={participants}
                                focusId={focusId} povId={povId} onFocus={changeFocus} onPov={changePov}
                            />
                        )}
                        {sideTab === 'events' && (
                            <ReplayEventList
                                analysis={analysis} position={position} simulationHz={simulationHz} participants={participants}
                                focusId={focusId} onJump={jumpToEvent}
                            />
                        )}
                        {sideTab === 'paths' && (
                            <ReplayPathMap analysis={analysis} position={position} map={mapView} participants={participants} focusId={focusId} theme={theme}/>
                        )}
                    </div>
                </aside>
            </div>

            <ReplayTimeline analysis={analysis} position={position} simulationHz={simulationHz} participants={participants} focusId={focusId} onSeek={(frame) => { setPlaying(false); seek(frame); }}/>

            <footer className="replay-transport">
                <div className="replay-transport-group">
                    <button type="button" className="replay-tool" onClick={() => adjacentEvent(-1)} title={t('replay.analysis.prevEvent')} aria-label={t('replay.analysis.prevEvent')}>
                        <Icon name="back" size={22}/><Icon name="flag" size={18}/>
                    </button>
                    <button type="button" className="replay-tool" onClick={() => seekSeconds(-5)} title={t('replay.analysis.back5')}>−5s</button>
                    <button type="button" className="replay-tool" onClick={() => { setPlaying(false); seek(position - 1); }} title={t('replay.analysis.prevFrame')} aria-label={t('replay.analysis.prevFrame')}>
                        <Icon name="back" size={22}/>
                    </button>
                    <button type="button" className="replay-tool is-primary" onClick={togglePlay} aria-label={t(playing ? 'replay.pause' : 'replay.play')} disabled={simulationHz === null}>
                        {playing ? <span className="replay-pause-glyph" aria-hidden="true"/> : <Icon name="play" size={24}/>}
                        <span>{t(playing ? 'replay.pause' : 'replay.play')}</span>
                    </button>
                    <button type="button" className="replay-tool" onClick={() => { setPlaying(false); seek(position + 1); }} title={t('replay.analysis.nextFrame')} aria-label={t('replay.analysis.nextFrame')}>
                        <Icon name="next" size={22}/>
                    </button>
                    <button type="button" className="replay-tool" onClick={() => seekSeconds(5)} title={t('replay.analysis.fwd5')}>+5s</button>
                    <button type="button" className="replay-tool" onClick={() => adjacentEvent(1)} title={t('replay.analysis.nextEvent')} aria-label={t('replay.analysis.nextEvent')}>
                        <Icon name="flag" size={18}/><Icon name="next" size={22}/>
                    </button>
                </div>
                <span className="replay-clock">
                    <b>{formatReplayTime(currentTick - startTick, simulationHz)}</b>
                    <span> / {formatReplayTime(endTick - startTick, simulationHz)}</span>
                </span>
                <div className="replay-segmented replay-speed" role="group" aria-label={t('replay.analysis.speed')}>
                    {REPLAY_SPEEDS.map((value) => (
                        <button key={value} type="button" aria-pressed={speed === value} onClick={() => setSpeed(value)}>{value}×</button>
                    ))}
                </div>
                <div className="replay-transport-group">
                    <button type="button" className="replay-tool" aria-pressed={focusId === null} onClick={() => changeFocus(null)} title={t('replay.analysis.wholeMapHint')}>
                        <Icon name="map" size={20}/><span>{t('replay.analysis.wholeMap')}</span>
                    </button>
                    {saveSlot}
                </div>
            </footer>
            <p className="replay-shortcuts">{t('replay.analysis.shortcuts')}</p>
        </div>
    );
};
