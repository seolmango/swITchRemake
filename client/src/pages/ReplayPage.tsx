import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { Icon } from '../components/common/Icon.tsx';
import { SwitchGame } from '../game/SwitchGame.tsx';
import { EngineMode, type SwitchEngine } from '../game/index.ts';
import { verifiedMapView } from '../game/mapBundle.ts';
import { PROTOCOL_VERSION, type RecordedFrame } from 'shared';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { themeColors } from '../theme/color.ts';
import { frameBuffer, loadFrames, openReplay, ReplayOpenError, type OpenedReplay, type ReplayVerification } from '../replay/replayFile.ts';

/** 인게임 서버가 맵 번들을 내주는 주소. 살아 있는 세션이 없으므로 GameSession과 같은 규칙으로 만든다. */
function gameHttpOrigin(): string {
    const configured = (import.meta.env.VITE_GAME_WS_ORIGIN as string | undefined)?.trim();
    const url = new URL('/', configured || window.location.origin);
    url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
    return url.origin;
}

type LoadState =
    | { kind: 'empty' }
    | { kind: 'reading' }
    | { kind: 'failed'; message: string; verification: ReplayVerification }
    | { kind: 'ready'; replay: OpenedReplay; frames: RecordedFrame[] };

export const ReplayPage: React.FC = () => {
    const { t, i18n } = useTranslation();
    const colors = themeColors(useSettingsStore((state) => state.theme));
    const [state, setState] = useState<LoadState>({ kind: 'empty' });
    const [mapError, setMapError] = useState<string | null>(null);
    const [playing, setPlaying] = useState(false);
    const [position, setPosition] = useState(0);
    const engineRef = useRef<SwitchEngine | null>(null);
    const mapReady = useRef(false);

    const replay = state.kind === 'ready' ? state.replay : null;
    const frames = state.kind === 'ready' ? state.frames : null;

    const open = useCallback(async (file: File) => {
        setState({ kind: 'reading' });
        setPlaying(false);
        setPosition(0);
        mapReady.current = false;
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const opened = await openReplay(bytes);
            // 프레임은 전부 미리 푼다. 경기가 10분을 넘지 않아서 메모리가 감당되고,
            // 그 대신 어디로든 즉시 되감을 수 있다.
            const all: RecordedFrame[] = [];
            for (let i = 0; i < opened.chunkIndex.length; i++) all.push(...await loadFrames(opened, i));
            all.sort((a, b) => a.tick - b.tick);
            setState({ kind: 'ready', replay: opened, frames: all });
        } catch (error) {
            setState({
                kind: 'failed',
                message: error instanceof Error ? error.message : String(error),
                verification: error instanceof ReplayOpenError ? error.verification : 'unsupported',
            });
        }
    }, []);

    /** 델타 프레임이라 아무 데서나 시작할 수 없다. 앞선 full 프레임부터 훑어 와야 그 tick이 완성된다. */
    const applyUpTo = useCallback((target: number) => {
        const engine = engineRef.current;
        if (!engine || !frames || !replay || !mapReady.current) return;
        let start = target;
        while (start > 0 && !frames[start]!.full) start -= 1;
        for (let i = start; i <= target; i++) {
            engine.applySnapshot(frameBuffer(frames[i]!), replay.manifest.snapshotHz);
        }
    }, [frames, replay]);

    const handleEngine = useCallback((engine: SwitchEngine | null) => {
        engineRef.current = engine;
        mapReady.current = false;
    }, []);

    // 맵은 manifest의 해시로 받는다. 그때 쓰던 번들을 그대로 가져오므로 규칙이 바뀐 뒤에도
    // 그 경기의 지형이 나온다. 서버가 그 번들을 더 이상 안 갖고 있으면 재생할 수 없다.
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine || !replay) return;
        let cancelled = false;
        setMapError(null);
        void (async () => {
            try {
                const { view } = await verifiedMapView(replay.manifest.mapId, replay.manifest.mapBundleHash, gameHttpOrigin());
                if (cancelled || engineRef.current !== engine) return;
                engine.map.load(view);
                await engine.whenReady();
                if (cancelled || engineRef.current !== engine) return;
                mapReady.current = true;
                applyUpTo(0);
            } catch (error) {
                if (!cancelled) setMapError(error instanceof Error ? error.message : String(error));
            }
        })();
        return () => { cancelled = true; };
    }, [replay, applyUpTo]);

    useEffect(() => {
        if (!playing || !frames || !replay) return;
        const stepMs = 1000 / Math.max(1, replay.manifest.snapshotHz);
        const timer = window.setInterval(() => {
            setPosition((current) => {
                const next = current + 1;
                if (next >= frames.length) {
                    setPlaying(false);
                    return current;
                }
                return next;
            });
        }, stepMs);
        return () => window.clearInterval(timer);
    }, [playing, frames, replay]);

    useEffect(() => { applyUpTo(position); }, [position, applyUpTo]);

    const meta = useMemo(() => {
        if (!replay) return null;
        const manifest = replay.manifest;
        const seconds = Math.round(manifest.durationTicks / Math.max(1, manifest.snapshotHz));
        return {
            recordedAt: manifest.recordedAt
                ? new Date(manifest.recordedAt).toLocaleString(i18n.language)
                : null,
            duration: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
            protocolMismatch: manifest.protocolVersion !== PROTOCOL_VERSION,
        };
    }, [replay, i18n.language]);

    return (
        <PageLayout title={t('replay.title')}>
            <div className="replay-shell" style={{ '--surface-border': colors.panelBorder, '--surface-muted': colors.muted } as React.CSSProperties}>
                {state.kind !== 'ready' && (
                    <label
                        className="replay-dropzone"
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                            event.preventDefault();
                            const file = event.dataTransfer.files[0];
                            if (file) void open(file);
                        }}
                    >
                        <Icon name="external" size={48}/>
                        <strong>{state.kind === 'reading' ? t('replay.reading') : t('replay.dropHint')}</strong>
                        <span>{t('replay.dropSub')}</span>
                        <input
                            type="file"
                            accept=".swrp,.swr,application/octet-stream"
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (file) void open(file);
                            }}
                        />
                        {state.kind === 'failed' && (
                            <p className="replay-error" role="alert">
                                {t(state.verification === 'modified' ? 'replay.verify.modified' : 'replay.verify.unsupported')}
                                <small>{state.message}</small>
                            </p>
                        )}
                    </label>
                )}

                {replay && meta && (
                    <>
                        <section className="replay-meta" aria-label={t('replay.about')}>
                            <div className={`replay-verdict is-${replay.verification}`}>
                                <strong>{t(`replay.verify.${replay.verification}`)}</strong>
                                <small>{t(`replay.verifyHint.${replay.verification}`)}</small>
                            </div>
                            <dl>
                                <div><dt>{t('replay.recordedAt')}</dt><dd>{meta.recordedAt ?? t('replay.recordedAtUnknown')}</dd></div>
                                <div><dt>{t('replay.map')}</dt><dd>{replay.manifest.mapId}</dd></div>
                                <div><dt>{t('replay.duration')}</dt><dd>{meta.duration}</dd></div>
                                <div><dt>{t('replay.build')}</dt><dd>{replay.manifest.buildId}</dd></div>
                                <div><dt>{t('replay.rules')}</dt><dd>{replay.manifest.rulesVersion}</dd></div>
                                <div>
                                    <dt>{t('replay.protocol')}</dt>
                                    <dd>{replay.manifest.protocolVersion}{meta.protocolMismatch ? ` · ${t('replay.protocolMismatch')}` : ''}</dd>
                                </div>
                            </dl>
                            <ul className="replay-participants">
                                {replay.manifest.participants.map((participant) => (
                                    <li key={participant.playerId}>
                                        <i>{participant.playerId}</i>
                                        {participant.nickname}{participant.guest ? ` · ${t('admin.guestBadge')}` : ''}
                                    </li>
                                ))}
                            </ul>
                        </section>

                        <div className="replay-stage">
                            <SwitchGame mode={EngineMode.Spectate} onEngine={handleEngine} matchReady/>
                            {mapError && <p className="replay-error" role="alert">{t('replay.mapFailed')}<small>{mapError}</small></p>}
                        </div>

                        <footer className="replay-controls">
                            <RoundButton
                                width={160}
                                height={72}
                                type={1}
                                content={t(playing ? 'replay.pause' : 'replay.play')}
                                onClick={() => setPlaying((value) => !value)}
                            />
                            <input
                                type="range"
                                min={0}
                                max={Math.max(0, (frames?.length ?? 1) - 1)}
                                value={position}
                                aria-label={t('replay.seek')}
                                onChange={(event) => { setPlaying(false); setPosition(Number(event.target.value)); }}
                            />
                            <span className="replay-position">
                                {frames ? `${position + 1} / ${frames.length}` : ''}
                            </span>
                        </footer>
                    </>
                )}
            </div>
        </PageLayout>
    );
};
