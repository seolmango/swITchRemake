import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { Icon } from '../components/common/Icon.tsx';
import { PROTOCOL_VERSION, type RecordedEvent, type RecordedFrame, type RecordedVisibility } from 'shared';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { themeColors } from '../theme/color.ts';
import { loadChunk, openReplay, readReplayFile, ReplayOpenError, type OpenedReplay, type ReplayVerification } from '../replay/replayFile.ts';
import { buildReplayAnalysis, type ReplayAnalysis } from '../replay/analysis.ts';
import { loadReplayVerifier } from '../replay/browserVerifier.ts';
import { createReplayTicket } from '../api/profile.ts';
import { getRetentionSettings } from '../api/config.ts';
import { ApiError } from '../api/http.ts';
import { ReplayAnalyzer } from './replay/ReplayAnalyzer.tsx';

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
    | { kind: 'fetching' }
    | { kind: 'fetchFailed'; reason: 'gone' | 'login' | 'failed' }
    | { kind: 'failed'; message: string; verification: ReplayVerification }
    | { kind: 'ready'; replay: OpenedReplay; frames: RecordedFrame[]; analysis: ReplayAnalysis };

/** 전적에서 바로 연 리플레이. 표는 한 번 쓰면 사라지므로, 저장하려면 받아 둔 바이트를 그대로 내려준다. */
interface FetchedReplay {
    blob: Blob;
    fileName: string;
}

/**
 * 전적의 "바로 재생"이 여는 길. 표를 끊고 그 주소에서 파일을 받는다 — 저장 버튼과 같은 표,
 * 같은 파일이라 서버에 새 길을 내지 않는다. 받은 파일은 끌어다 놓은 파일과 똑같이 검증한다.
 */
async function fetchMatchReplay(matchId: string): Promise<FetchedReplay> {
    const ticket = await createReplayTicket(matchId);
    const response = await fetch(`${gameHttpOrigin()}${ticket.path}`, { cache: 'no-store' });
    if (!response.ok) throw new ApiError(response.status, null);
    const fileName = decodeURIComponent(ticket.path.slice('/replays/'.length).split('?')[0] ?? '') || `${matchId}.swrp`;
    return { blob: await response.blob(), fileName };
}

const ACCEPT = '.swrp,.swr,application/octet-stream';

export const ReplayPage: React.FC = () => {
    const { t, i18n } = useTranslation();
    const [searchParams] = useSearchParams();
    const matchId = searchParams.get('match');
    const [fetched, setFetched] = useState<FetchedReplay | null>(null);
    const [replayHours, setReplayHours] = useState<number | null>(null);
    const colors = themeColors(useSettingsStore((state) => state.theme));
    // 전적에서 왔으면 처음부터 "받는 중"이다. 빈 끌어놓기 칸이 한 번 깜빡이면 안 된다.
    const [state, setState] = useState<LoadState>(() => matchId ? { kind: 'fetching' } : { kind: 'empty' });
    const [verifier] = useState(loadReplayVerifier);
    /** 파일을 새로 열 때마다 분석 화면을 새로 띄운다. 이전 경기의 재생 위치·시점이 남으면 안 된다. */
    const [openCount, setOpenCount] = useState(0);

    const open = useCallback(async (file: Blob, source: FetchedReplay | null = null) => {
        setFetched(source);
        setState({ kind: 'reading' });
        try {
            const bytes = await readReplayFile(file);
            // 공개키는 파일마다 다시 받지 않는다. 못 받아도 재생은 되고 '확인할 수 없음'이 된다.
            const opened = await openReplay(bytes, await verifier);
            // chunk는 전부 미리 푼다. 경기가 10분을 넘지 않아서 메모리가 감당되고, 그 대신 어디로든
            // 즉시 되감을 수 있고 경기 전체의 사건·통계를 처음부터 보여 줄 수 있다.
            const frames: RecordedFrame[] = [];
            const events: RecordedEvent[] = [];
            const visibilities: RecordedVisibility[] = [];
            for (let i = 0; i < opened.chunkIndex.length; i++) {
                const chunk = await loadChunk(opened, i);
                frames.push(...chunk.frames);
                events.push(...chunk.events);
                visibilities.push(...chunk.visibilities);
            }
            frames.sort((a, b) => a.tick - b.tick);
            const analysis = buildReplayAnalysis({ manifest: opened.manifest, frames, events, visibilities });
            setOpenCount((count) => count + 1);
            setState({ kind: 'ready', replay: opened, frames, analysis });
        } catch (error) {
            setState({
                kind: 'failed',
                message: error instanceof Error ? error.message : String(error),
                verification: error instanceof ReplayOpenError ? error.verification : 'unsupported',
            });
        }
    }, [verifier]);

    useEffect(() => {
        if (!matchId) return;
        let cancelled = false;
        void fetchMatchReplay(matchId).then((source) => {
            if (!cancelled) void open(source.blob, source);
        }).catch((error: unknown) => {
            if (cancelled) return;
            const status = error instanceof ApiError ? error.status : 0;
            // 게스트 세션은 계정 전용 경로에서 403을 받는다. 참가자가 아니라서 받는 403은 따로 코드가 있다.
            const needsLogin = status === 401
                || (status === 403 && (error as ApiError).code !== 'NOT_MATCH_PARTICIPANT');
            setState({ kind: 'fetchFailed', reason: status === 404 ? 'gone' : needsLogin ? 'login' : 'failed' });
        });
        return () => { cancelled = true; };
    }, [matchId, open]);

    // 서버에서 받은 것만 저장을 권한다. 보관 시간은 서버가 정한다 — 못 받아 오면 숫자를 말하지 않는다.
    useEffect(() => {
        if (!fetched) return;
        let active = true;
        void getRetentionSettings().then((settings) => { if (active) setReplayHours(settings.replayHours); }).catch(() => undefined);
        return () => { active = false; };
    }, [fetched]);

    const saveFetched = useCallback(() => {
        if (!fetched) return;
        const url = URL.createObjectURL(fetched.blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fetched.fileName;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }, [fetched]);

    const replay = state.kind === 'ready' ? state.replay : null;
    const meta = useMemo(() => {
        if (!replay || state.kind !== 'ready') return null;
        const manifest = replay.manifest;
        const ticks = state.analysis.ticks;
        // 길이는 맵 번들의 시뮬레이션 주기를 알아야 초로 바뀐다. 그 전에는 프레임 수로 어림하지 않는다.
        return {
            recordedAt: manifest.recordedAt ? new Date(manifest.recordedAt).toLocaleString(i18n.language) : null,
            frames: ticks.length,
            protocolMismatch: manifest.protocolVersion !== PROTOCOL_VERSION,
        };
    }, [replay, state, i18n.language]);

    const pickFile = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) void open(file);
    };

    return (
        <PageLayout title={t('replay.title')}>
            <div className={`replay-shell${state.kind === 'ready' ? ' is-ready' : ''}`} style={{ '--surface-border': colors.panelBorder, '--surface-muted': colors.muted } as React.CSSProperties}>
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
                        <Icon name="play" size={48}/>
                        <strong>{state.kind === 'reading' ? t('replay.reading') : state.kind === 'fetching' ? t('replay.fetching') : t('replay.dropHint')}</strong>
                        <span>{t('replay.dropSub')}</span>
                        <input type="file" accept={ACCEPT} onChange={pickFile}/>
                        {state.kind === 'fetchFailed' && (
                            <p className="replay-error" role="alert">
                                {t(state.reason === 'gone' ? 'replay.fetchGone' : state.reason === 'login' ? 'replay.fetchLogin' : 'replay.fetchFailed')}
                            </p>
                        )}
                        {state.kind === 'failed' && (
                            <p className="replay-error" role="alert">
                                {t(state.verification === 'modified' ? 'replay.verify.modified' : 'replay.verify.unsupported')}
                                <small>{state.message}</small>
                            </p>
                        )}
                    </label>
                )}

                {state.kind === 'ready' && replay && meta && (
                    <>
                        <header className="replay-header" aria-label={t('replay.about')}>
                            <div className={`replay-verdict is-${replay.verification}`} title={t(`replay.verifyHint.${replay.verification}`)}>
                                <strong>{t(`replay.verify.${replay.verification}`)}</strong>
                                <small>{t(`replay.verifyHint.${replay.verification}`)}</small>
                            </div>
                            <dl className="replay-facts">
                                <div><dt>{t('replay.map')}</dt><dd>{t(`lobby.maps.${replay.manifest.mapId}`, { defaultValue: replay.manifest.mapId })}</dd></div>
                                <div><dt>{t('replay.recordedAt')}</dt><dd>{meta.recordedAt ?? t('replay.recordedAtUnknown')}</dd></div>
                                <div><dt>{t('replay.analysis.players')}</dt><dd>{replay.manifest.participants.length}</dd></div>
                                <div><dt>{t('replay.analysis.eliminations')}</dt><dd>{state.analysis.events.filter((e) => e.kind === 'elimination').length}</dd></div>
                            </dl>
                            <details className="replay-file-info">
                                <summary>{t('replay.analysis.fileInfo')}</summary>
                                <dl>
                                    <div><dt>{t('replay.build')}</dt><dd>{replay.manifest.buildId}</dd></div>
                                    <div><dt>{t('replay.rules')}</dt><dd>{replay.manifest.rulesVersion}</dd></div>
                                    <div>
                                        <dt>{t('replay.protocol')}</dt>
                                        <dd>{replay.manifest.protocolVersion}{meta.protocolMismatch ? ` · ${t('replay.protocolMismatch')}` : ''}</dd>
                                    </div>
                                    <div><dt>{t('replay.analysis.frames')}</dt><dd>{meta.frames} · {replay.manifest.snapshotHz}Hz</dd></div>
                                </dl>
                            </details>
                            <label className="replay-tool replay-open-other">
                                <Icon name="external" size={20}/>
                                <span>{t('replay.analysis.openOther')}</span>
                                <input type="file" accept={ACCEPT} onChange={pickFile}/>
                            </label>
                        </header>

                        <ReplayAnalyzer
                            key={openCount}
                            manifest={replay.manifest}
                            frames={state.frames}
                            analysis={state.analysis}
                            gameOrigin={gameHttpOrigin()}
                            {...(fetched ? {
                                saveSlot: (
                                    <button
                                        type="button"
                                        className="replay-tool"
                                        onClick={saveFetched}
                                    >
                                        <Icon name="download" size={20}/>
                                        <span>{t('replay.save')}</span>
                                    </button>
                                ),
                            } : {})}
                        />
                        {fetched && replayHours !== null && <p className="replay-save-note">{t('replay.saveHint', { hours: replayHours })}</p>}
                    </>
                )}
            </div>
        </PageLayout>
    );
};

