import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { RoundBox } from '../components/common/RoundBox.tsx';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { Icon } from '../components/common/Icon.tsx';
import { getLoginSessions, revokeLoginSession, revokeOtherLoginSessions, type LoginSession } from '../api/sessions.ts';
import { useAuthStore } from '../stores/useAuthStore.ts';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { Color, themeColors } from '../theme/color.ts';
import { loginErrorMessage } from './auth/authErrorMessage.ts';
import { getMyMatches, getMyStats, type UserMatchHistoryItem, type UserStats } from '../api/profile.ts';

type RecordsState =
    | { kind: 'loading' }
    | { kind: 'failed' }
    | { kind: 'ready'; stats: UserStats; matches: UserMatchHistoryItem[] };

export const ProfilePage: React.FC = () => {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const { status, nickname, logout } = useAuthStore();
    const theme = useSettingsStore((state) => state.theme);
    const colors = themeColors(theme);
    const authenticated = status === 'account';
    const [sessions, setSessions] = useState<LoginSession[]>([]);
    const [loadingSessions, setLoadingSessions] = useState(true);
    const [sessionAction, setSessionAction] = useState<string | null>(null);
    const [sessionMessage, setSessionMessage] = useState('');
    const sessionListRef = useRef<HTMLDivElement>(null);
    const drag = useRef<{ pointerId: number; lastY: number; scale: number } | null>(null);
    const [hasSessionOverflow, setHasSessionOverflow] = useState(false);
    const [records, setRecords] = useState<RecordsState>({ kind: 'loading' });

    const loadRecords = useCallback(async () => {
        if (!authenticated) return;
        setRecords({ kind: 'loading' });
        try {
            const [stats, history] = await Promise.all([getMyStats(), getMyMatches({ limit: 5 })]);
            setRecords({ kind: 'ready', stats, matches: history.matches });
        } catch {
            setRecords({ kind: 'failed' });
        }
    }, [authenticated]);

    const loadSessions = useCallback(async () => {
        if (!authenticated) return;
        setLoadingSessions(true);
        try {
            const result = await getLoginSessions();
            setSessions(result.sessions);
            setSessionMessage('');
        } catch {
            setSessionMessage(t('profile.sessionsLoadFailed'));
        } finally {
            setLoadingSessions(false);
        }
    }, [authenticated, t]);

    useEffect(() => {
        if (!authenticated) return;
        let active = true;
        void getLoginSessions().then((result) => {
            if (!active) return;
            setSessions(result.sessions);
            setSessionMessage('');
        }).catch(() => {
            if (active) setSessionMessage(t('profile.sessionsLoadFailed'));
        }).finally(() => {
            if (active) setLoadingSessions(false);
        });
        return () => { active = false; };
    }, [authenticated, t]);

    // 최초 로드와 재시도·새로고침 버튼이 같은 함수를 쓴다. 같은 fetch를 두 벌 두면 한쪽만 고쳐진다.
    useEffect(() => { void loadRecords(); }, [loadRecords]);

    const revokeSession = async (session: LoginSession) => {
        setSessionAction(session.id);
        try {
            await revokeLoginSession(session.id);
            if (session.current) {
                await logout();
                navigate('/', { replace: true });
                return;
            }
            setSessions((current) => current.filter((item) => item.id !== session.id));
            setSessionMessage(t('profile.sessionRevoked'));
        } catch {
            setSessionMessage(t('profile.sessionActionFailed'));
        } finally {
            setSessionAction(null);
        }
    };

    const revokeOthers = async () => {
        setSessionAction('others');
        try {
            const result = await revokeOtherLoginSessions();
            setSessions((current) => current.filter((session) => session.current));
            setSessionMessage(t('profile.otherSessionsRevoked', { count: result.revokedCount }));
        } catch {
            setSessionMessage(t('profile.sessionActionFailed'));
        } finally {
            setSessionAction(null);
        }
    };

    const formatDate = (value: string) => new Intl.DateTimeFormat(i18n.language, {
        dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(value));
    const formatNumber = (value: number) => new Intl.NumberFormat(i18n.language).format(value);
    const formatDuration = (value: number) => t('profile.seconds', { count: Math.floor(value / 1_000) });

    useEffect(() => {
        const list = sessionListRef.current;
        if (!list) return;
        const updateOverflow = () => setHasSessionOverflow(list.scrollHeight > list.clientHeight + 1);
        updateOverflow();
        const observer = new ResizeObserver(updateOverflow);
        observer.observe(list);
        return () => observer.disconnect();
    }, [loadingSessions, sessions]);

    const beginSessionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || (event.target as Element).closest('button')) return;
        const list = event.currentTarget;
        const scale = list.offsetHeight === 0 ? 1 : list.getBoundingClientRect().height / list.offsetHeight;
        drag.current = { pointerId: event.pointerId, lastY: event.clientY, scale: scale || 1 };
        list.setPointerCapture(event.pointerId);
    };

    const dragSessionList = (event: React.PointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        if (current?.pointerId !== event.pointerId) return;
        event.currentTarget.scrollTop += (current.lastY - event.clientY) / current.scale;
        current.lastY = event.clientY;
    };

    const endSessionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    if (!authenticated) {
        return (
            <PageLayout title={t('profile.title')} home>
                <RoundBox x={960} y={550} width={1280} height={800} type={2}/>
                <section className="profile-panel">
                    <div className="profile-avatar" style={{ borderColor: Color.blue[2], color: Color.blue[2], background: theme === 0 ? Color.blue[0] : 'transparent' }}><Icon name="person" size={130}/></div>
                    <h2>{t('profile.guestTitle')}</h2>
                    <p style={{ color: colors.muted }}>{t('profile.guestBody')}</p>
                    <RoundBox width={900} height={175} type={1} style={{ display: 'grid', placeItems: 'center', padding: 28, textAlign: 'center', color: colors.text, fontSize: 27, lineHeight: 1.45 }}>
                        {t('profile.guestStats')}
                    </RoundBox>
                    <div className="profile-actions">
                        <RoundButton width={360} height={96} type={1} content={t('auth.login')} onClick={() => navigate('/login')}/>
                        <RoundButton width={360} height={96} type={0} content={t('auth.signup')} onClick={() => navigate('/signup')}/>
                    </div>
                </section>
            </PageLayout>
        );
    }

    return (
        <PageLayout title={t('profile.title')} home>
            <RoundBox x={960} y={550} width={1540} height={800} type={2}/>
            <section className="profile-panel is-authenticated">
                <div className="profile-summary">
                    <div className="profile-avatar" style={{ borderColor: Color.blue[2], color: Color.blue[2], background: theme === 0 ? Color.blue[0] : 'transparent' }}><Icon name="person" size={115}/></div>
                    <h2>{nickname ?? 'swITch'}</h2>
                    <p style={{ color: colors.muted }}>{t('profile.loggedBody')}</p>
                    <section
                        className="profile-stats-card"
                        style={{ '--profile-border': colors.panelBorder, '--profile-field': colors.field, '--profile-muted': colors.muted } as React.CSSProperties}
                        aria-label={t('profile.statsTitle')}
                    >
                        <span>{t('profile.statsKicker')}</span>
                        {records.kind === 'loading' && <div className="profile-record-state" aria-busy="true">{t('profile.statsLoading')}</div>}
                        {records.kind === 'failed' && (
                            <div className="profile-record-state is-failed" role="alert">
                                <span>{t('profile.statsLoadFailed')}</span>
                                <button type="button" onClick={() => void loadRecords()}>{t('profile.retryStats')}</button>
                            </div>
                        )}
                        {records.kind === 'ready' && (
                            <div className="profile-stat-grid">
                                <span><strong>{formatNumber(records.stats.games)}</strong><small>{t('profile.games')}</small></span>
                                <span><strong>{formatNumber(records.stats.wins)}</strong><small>{t('profile.wins')}</small></span>
                                <span><strong>{records.stats.winRate}%</strong><small>{t('profile.winRate')}</small></span>
                                <span><strong>{records.stats.switchSuccessRate}%</strong><small>{t('profile.switchRate')}</small></span>
                                <span><strong>{formatNumber(records.stats.tagCount)}</strong><small>{t('profile.tags')}</small></span>
                                <span><strong>{formatNumber(records.stats.level)}</strong><small>{t('profile.level')}</small></span>
                            </div>
                        )}
                    </section>
                    <div className="profile-actions is-compact">
                        <RoundButton width={220} height={76} type={1} content={t('profile.changePassword')} onClick={() => navigate('/change-password')}/>
                        <RoundButton width={170} height={76} type={0} content={t('auth.logout')} onClick={() => {
                            void logout()
                                .then(() => navigate('/', { replace: true }))
                                .catch((error: unknown) => setSessionMessage(loginErrorMessage(error, t)));
                        }}/>
                    </div>
                </div>

                <div className="profile-detail-stack">
                    <section className="match-history-panel" style={{ '--profile-border': colors.panelBorder, '--profile-field': colors.field, '--profile-muted': colors.muted } as React.CSSProperties}>
                        <header>
                            <div>
                                <span>{t('profile.historyKicker')}</span>
                                <h2>{t('profile.recentMatches')}</h2>
                            </div>
                            <button type="button" onClick={() => void loadRecords()} disabled={records.kind === 'loading'} aria-label={t('rooms.refresh')}><Icon name="refresh" size={28}/></button>
                        </header>
                        {records.kind === 'loading' && <div className="match-history-state" aria-busy="true">{t('profile.matchesLoading')}</div>}
                        {records.kind === 'failed' && <div className="match-history-state is-failed" role="alert">{t('profile.matchesLoadFailed')}</div>}
                        {records.kind === 'ready' && records.matches.length === 0 && <div className="match-history-state">{t('profile.noMatches')}</div>}
                        {records.kind === 'ready' && records.matches.length > 0 && (
                            <div className="match-history-list" aria-label={t('profile.recentMatches')}>
                                {records.matches.map((match) => (
                                    <article key={match.matchId}>
                                        <div className={match.won ? 'is-win' : 'is-loss'}>
                                            <strong>{t(match.won ? 'profile.victory' : 'profile.defeat')}</strong>
                                            <span>{t(`lobby.maps.${match.map}`, { defaultValue: match.map })}</span>
                                        </div>
                                        <div className="match-history-stats">
                                            <span>{t('profile.matchTags', { count: match.tagCount })}</span>
                                            <span>{t('profile.matchTagged', { count: match.taggedCount })}</span>
                                            <span>{t('profile.matchSwitch', { success: match.switchSuccess, tries: match.switchTry })}</span>
                                            <span>{t('profile.matchSurvived', { duration: formatDuration(match.survivedMs) })}</span>
                                        </div>
                                        <time dateTime={match.endedAt}>{formatDate(match.endedAt)}</time>
                                    </article>
                                ))}
                            </div>
                        )}
                    </section>

                    <section className="session-panel" style={{ '--session-border': colors.panelBorder, '--session-field': colors.field, '--session-muted': colors.muted } as React.CSSProperties}>
                    <header>
                        <div>
                            <span>{t('profile.securityKicker')}</span>
                            <h2>{t('profile.loginDevices')}</h2>
                        </div>
                        <button type="button" onClick={() => void loadSessions()} disabled={loadingSessions} aria-label={t('rooms.refresh')}><Icon name="refresh" size={28}/></button>
                    </header>
                    <p>{t('profile.loginDevicesHelp')}</p>
                    <div
                        ref={sessionListRef}
                        className={`session-list ${hasSessionOverflow ? 'has-overflow' : ''}`}
                        aria-busy={loadingSessions}
                        aria-label={t('profile.loginDevices')}
                        tabIndex={0}
                        onPointerDown={beginSessionDrag}
                        onPointerMove={dragSessionList}
                        onPointerUp={endSessionDrag}
                        onPointerCancel={endSessionDrag}
                    >
                        {sessions.map((session) => (
                            <article key={session.id} className={session.current ? 'is-current' : ''}>
                                <Icon name="person" size={34}/>
                                <div>
                                    <strong>{session.deviceLabel}</strong>
                                    <span>{t('profile.lastActive', { date: formatDate(session.lastUsedAt) })}</span>
                                </div>
                                {session.current && <span className="session-current-badge">{t('profile.currentDevice')}</span>}
                                <button type="button" className="session-revoke" disabled={sessionAction !== null} onClick={() => void revokeSession(session)}>
                                    {session.current ? t('auth.logout') : t('profile.revokeSession')}
                                </button>
                            </article>
                        ))}
                        {!loadingSessions && sessions.length === 0 && <div className="session-empty">{t('profile.noSessions')}</div>}
                    </div>
                    {hasSessionOverflow && <span className="session-scroll-hint">{t('profile.sessionScrollHint')}</span>}
                    <footer>
                        <span role="status" aria-live="polite">{sessionMessage}</span>
                        <button type="button" disabled={sessionAction !== null || sessions.every((session) => session.current)} onClick={() => void revokeOthers()}>
                            {t('profile.revokeOthers')}
                        </button>
                    </footer>
                    </section>
                </div>
            </section>
        </PageLayout>
    );
};
