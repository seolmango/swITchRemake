import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../../components/layout/PageLayout.tsx';
import { RoundButton } from '../../components/common/RoundButton.tsx';
import { Icon } from '../../components/common/Icon.tsx';
import { MatchResultTable } from '../../components/match/MatchResultTable.tsx';
import { ReportDialog } from '../../components/match/ReportDialog.tsx';
import { useAuthStore } from '../../stores/useAuthStore.ts';
import { getRetentionSettings, type RetentionSettings } from '../../api/config.ts';
import { MatchRewardCard } from '../../components/match/MatchRewardCard.tsx';
import { getMatchResult, type MatchPlayerResult, type MatchResultSnapshot } from '../../api/matches.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { Color, themeColors } from '../../theme/color.ts';
import { isInAppBrowser, openInExternalBrowser } from '../../utils/inAppBrowser.ts';
import { createResultImage, shareOrSaveResultImage } from '../../utils/resultImage.ts';
import { isValidMatchId } from '../../utils/matchId.ts';
import { matchResultWinners } from '../../utils/matchResultWinners.ts';

const IN_APP_BROWSER = typeof navigator !== 'undefined' && isInAppBrowser();

const formatDuration = (durationMs: number) => {
    const totalSeconds = Math.floor(durationMs / 1000);
    return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
};

export const MatchResultPage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { matchId } = useParams();
    const [searchParams] = useSearchParams();
    const theme = useSettingsStore((state) => state.theme);
    const colors = themeColors(theme);
    const [result, setResult] = useState<MatchResultSnapshot | null>(null);
    const [message, setMessage] = useState('');
    const [loadFailed, setLoadFailed] = useState(false);
    const [retryToken, setRetryToken] = useState(0);
    const [remainingSeconds, setRemainingSeconds] = useState(30);
    const [sharing, setSharing] = useState(false);
    // 신고는 계정만 할 수 있다. 게스트에게 버튼을 보여 주면 눌러 보고 나서야 거절당한다.
    const canReport = useAuthStore((state) => state.status) === 'account';
    const [reporting, setReporting] = useState<MatchPlayerResult | null>(null);
    // 리플레이가 언제까지 남는지. 신고할 수 있는 기간이기도 하다.
    const [retention, setRetention] = useState<RetentionSettings | null>(null);

    useEffect(() => {
        let active = true;
        void getRetentionSettings().then((value) => { if (active) setRetention(value); }).catch(() => undefined);
        return () => { active = false; };
    }, []);
    const eventReturnsAtValue = Number(searchParams.get('returns_at'));
    const eventReturnsAt = Number.isFinite(eventReturnsAtValue) && eventReturnsAtValue > 0 ? eventReturnsAtValue : null;

    useEffect(() => {
        let active = true;
        let retryTimer: number | null = null;
        const load = async () => {
            if (!isValidMatchId(matchId)) {
                setLoadFailed(true);
                setMessage(t('result.invalidMatch'));
                return;
            }
            setLoadFailed(false);
            try {
                const response = await getMatchResult(matchId);
                if (!active) return;
                if ('status' in response) {
                    setMessage(t('common.loading'));
                    retryTimer = window.setTimeout(() => { void load(); }, response.retryAfterMs);
                    return;
                }
                setResult({ ...response, returnsAt: eventReturnsAt ?? response.returnsAt ?? Date.now() + 30_000 });
                setMessage('');
            } catch {
                if (!active) return;
                setLoadFailed(true);
                setMessage(t('auth.serverError'));
            }
        };
        void load();
        return () => {
            active = false;
            if (retryTimer !== null) window.clearTimeout(retryTimer);
        };
    }, [eventReturnsAt, matchId, retryToken, t]);

    const roomId = searchParams.get('room_id') || result?.roomId || '';
    const lobbyPath = roomId ? `/rooms/${encodeURIComponent(roomId)}/lobby` : '/rooms';

    const winners = useMemo(() => result === null ? [] : matchResultWinners(result), [result]);
    useEffect(() => {
        const returnsAt = result?.returnsAt ?? eventReturnsAt;
        if (returnsAt === null) return;
        const updateCountdown = () => {
            const nextSeconds = Math.max(0, Math.ceil((returnsAt - Date.now()) / 1000));
            setRemainingSeconds(nextSeconds);
            if (nextSeconds === 0) navigate(lobbyPath, { replace: true });
        };
        updateCountdown();
        const timer = window.setInterval(updateCountdown, 250);
        return () => window.clearInterval(timer);
    }, [eventReturnsAt, lobbyPath, navigate, result]);

    if (!result) {
        return (
            <PageLayout title={t('result.title')} backTo={lobbyPath}>
                <section className="result-shell" style={{ display: 'grid', placeItems: 'center', minHeight: 500 }}>
                    <div role="status" aria-live="polite" style={{ display: 'grid', gap: 20, justifyItems: 'center' }}>
                        <strong>{message || t('common.loading')}</strong>
                        {loadFailed && <RoundButton width={280} height={72} type={1} content={t('rooms.refresh')} onClick={() => setRetryToken((value) => value + 1)}/>}
                    </div>
                </section>
            </PageLayout>
        );
    }

    const getShareSummary = () => {
        if (winners.length === 0) return t('result.shareSummaryNoWinner');
        if (winners.length === 1) return t('result.shareSummarySingle', { winner: winners[0]!.nickname });
        const winnerNames = winners.map((winner) => winner.nickname).join(', ');
        return t('result.shareSummary', { winners: winnerNames });
    };

    const shareResultImage = async () => {
        if (IN_APP_BROWSER || sharing) return;
        setSharing(true);
        try {
            const image = await createResultImage(result, {
                title: t('result.title'),
                winner: t(winners.length === 1 ? 'result.winnerSingle' : 'result.winner'),
                noWinner: t('result.noWinner'),
                noWinnerDetail: t('result.noWinnerDetail'),
                victory: t(winners.length === 1 ? 'result.victorySingle' : 'result.victory'),
                map: t(`lobby.maps.${result.map}`, { defaultValue: result.map }),
                duration: formatDuration(result.durationMs),
                player: t('result.player'),
                switchRate: t('result.switchShort'),
                tags: t('result.tagsShort'),
                you: t('lobby.you'),
            });
            const action = await shareOrSaveResultImage(image, result.matchId, getShareSummary());
            setMessage(t(action === 'shared' ? 'result.imageShared' : 'result.imageSaved'));
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') setMessage(t('result.shareCancelled'));
            else setMessage(t('result.imageFailed'));
        } finally {
            setSharing(false);
        }
    };

    const openExternal = async () => {
        const outcome = await openInExternalBrowser();
        if (outcome === 'copied') setMessage(t('result.externalCopied'));
        if (outcome === 'unavailable') setMessage(t('result.externalUnavailable'));
    };

    return (
        <PageLayout title={t('result.title')} backTo={lobbyPath}>
            <section
                className="result-shell"
                style={{
                    '--surface': colors.panel,
                    '--surface-border': colors.panelBorder,
                    '--surface-field': colors.field,
                    '--surface-muted': colors.muted,
                    '--result-text': colors.text,
                    '--result-victory-fill': Color.frenzy[0],
                    '--result-victory-accent': Color.frenzy[2],
                    '--result-self-fill': Color.blue[0],
                    '--result-progress': Color.blue[2],
                    '--result-dark-text': Color.black,
                    '--result-table-header': colors.canvas,
                } as React.CSSProperties}
            >
                <div className={`result-main${winners.length > 2 ? ' has-many-winners' : ''}`}>
                    <aside className={`result-winner-panel has-${winners.length}-winners${winners.length > 2 ? ' has-many-winners' : ''}`}>
                        <span className="result-kicker">{t(winners.length === 0 ? 'result.noWinner' : winners.length === 1 ? 'result.winnerSingle' : 'result.winner')}</span>
                        <div className="result-winners" data-winner-count={winners.length}>
                            {winners.length === 0 ? (
                                <div className="result-no-winner">
                                    <Icon name="remove" size={58}/>
                                    <strong>{t('result.noWinner')}</strong>
                                    <p>{t('result.noWinnerDetail')}</p>
                                </div>
                            ) : winners.map((winner) => (
                                <article
                                    key={winner.playerId}
                                    style={{
                                        '--winner-fill': theme === 0 ? Color.user[(winner.slot - 1) % Color.user.length]![0] : 'transparent',
                                        '--winner-border': Color.user[(winner.slot - 1) % Color.user.length]![1],
                                    } as React.CSSProperties}
                                >
                                    <div
                                        className="result-winner-avatar"
                                        style={{
                                            background: Color.user[(winner.slot - 1) % Color.user.length]![0],
                                            borderColor: Color.user[(winner.slot - 1) % Color.user.length]![1],
                                        }}
                                    >
                                        <span>{winner.slot}</span>
                                        <i aria-hidden="true">★</i>
                                    </div>
                                    <div className="result-winner-copy">
                                        <h2 title={winner.nickname}>{winner.nickname}</h2>
                                        <p>{t('result.winnerDetail', { tags: winner.tagCount, success: winner.switchSuccess, tries: winner.switchTry })}</p>
                                    </div>
                                </article>
                            ))}
                        </div>
                        <div className="result-summary-grid">
                            <div><span>{t('lobby.map')}</span><strong>{t(`lobby.maps.${result.map}`, { defaultValue: result.map })}</strong></div>
                            <div><span>{t('result.duration')}</span><strong>{formatDuration(result.durationMs)}</strong></div>
                            <div><span>{t('result.players')}</span><strong>{result.players.length}</strong></div>
                        </div>
                    </aside>
                    <section className="result-stats-panel" aria-labelledby="result-stats-title">
                        <header>
                            <div>
                                <span className="result-kicker">{t('result.statsKicker')}</span>
                                <h2 id="result-stats-title">{t('result.details')}</h2>
                            </div>
                        </header>
                        <MatchResultTable
                            players={result.players}
                            winnerIds={winners.map((winner) => winner.playerId)}
                            {...(canReport ? { onReport: setReporting } : {})}
                        />
                        {result.reward && <MatchRewardCard reward={result.reward}/>}
                    </section>
                </div>
                <footer className="result-footer">
                    <div className="result-return-timer">
                        <Icon name="timer" size={31}/>
                    <div>
                            <strong>{t('result.returnCountdown', { seconds: remainingSeconds })}</strong>
                            <span role="status" aria-live="polite" style={{ color: colors.muted }}>{message || t('result.returnNotice')}</span>
                            {retention && (
                                <span className="result-retention-notice" style={{ color: colors.muted }}>
                                    {t('result.replayRetention', { days: retention.replayDays, count: retention.replayPerUserMatches })}
                                </span>
                            )}
                        </div>
                        <div className="result-timer-track" role="progressbar" aria-label={t('result.returnTimerLabel')} aria-valuemin={0} aria-valuemax={30} aria-valuenow={remainingSeconds}>
                            <i style={{ width: `${Math.min(100, remainingSeconds / 30 * 100)}%` }}/>
                        </div>
                    </div>
                        <div>
                        <RoundButton width={300} height={88} type={2} content={IN_APP_BROWSER ? t('result.shareUnavailable') : t('result.shareImage')} disabled={IN_APP_BROWSER} isLoading={sharing} onClick={() => void shareResultImage()}/>
                        {IN_APP_BROWSER && <button type="button" className="result-external-button" onClick={() => void openExternal()}><Icon name="external" size={24}/>{t('result.openExternal')}</button>}
                        <RoundButton width={350} height={88} type={1} content={t('result.backToLobby')} onClick={() => navigate(lobbyPath)}/>
                    </div>
                </footer>
            </section>
            {reporting && result && (
                <ReportDialog
                    matchId={result.matchId}
                    target={{
                        playerId: reporting.slot,
                        nickname: reporting.nickname,
                        // 안내 문구를 고르는 데만 쓴다. 계정인지 게스트인지의 판정은 서버가
                        // 명단을 보고 다시 한다 — 화면 말을 믿고 처리하지 않는다.
                        isGuest: reporting.isGuest,
                    }}
                    onClose={() => setReporting(null)}
                />
            )}
        </PageLayout>
    );
};
