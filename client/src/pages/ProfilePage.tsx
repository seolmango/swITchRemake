import React, { useCallback, useEffect, useState } from 'react';
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

export const ProfilePage: React.FC = () => {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const { status, nickname, logout } = useAuthStore();
    const theme = useSettingsStore((state) => state.theme);
    const colors = themeColors(theme);
    const authenticated = status === 'authenticated';
    const [sessions, setSessions] = useState<LoginSession[]>([]);
    const [loadingSessions, setLoadingSessions] = useState(true);
    const [sessionAction, setSessionAction] = useState<string | null>(null);
    const [sessionMessage, setSessionMessage] = useState('');

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

    const revokeSession = async (session: LoginSession) => {
        setSessionAction(session.id);
        try {
            await revokeLoginSession(session.id);
            if (session.current) {
                logout();
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

    if (!authenticated) {
        return (
            <PageLayout title={t('profile.title')} home>
                <RoundBox x={960} y={550} width={1280} height={800} type={2}/>
                <section className="profile-panel">
                    <div className="profile-avatar" style={{ borderColor: Color.blue[2], color: Color.blue[2], background: theme === 0 ? Color.blue[0] : 'transparent' }}><Icon name="person" size={130}/></div>
                    <h2>{t('profile.guestTitle')}</h2>
                    <p style={{ color: colors.muted }}>{t('profile.guestBody')}</p>
                    <RoundBox width={900} height={175} type={1} style={{ display: 'grid', placeItems: 'center', padding: 28, textAlign: 'center', color: colors.text, fontSize: 27, lineHeight: 1.45 }}>
                        {t('profile.statsPending')}
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
                    <RoundBox width={410} height={150} type={1} style={{ display: 'grid', placeItems: 'center', padding: 22, textAlign: 'center', color: colors.text, fontSize: 22, lineHeight: 1.4 }}>
                        {t('profile.statsPending')}
                    </RoundBox>
                    <div className="profile-actions is-compact">
                        <RoundButton width={220} height={76} type={1} content={t('profile.changePassword')} onClick={() => navigate('/change-password')}/>
                        <RoundButton width={170} height={76} type={0} content={t('auth.logout')} onClick={() => {
                            const current = sessions.find((session) => session.current);
                            if (current) void revokeSession(current);
                            else { logout(); navigate('/'); }
                        }}/>
                    </div>
                </div>

                <section className="session-panel" style={{ '--session-border': colors.panelBorder, '--session-field': colors.field, '--session-muted': colors.muted } as React.CSSProperties}>
                    <header>
                        <div>
                            <span>{t('profile.securityKicker')}</span>
                            <h2>{t('profile.loginDevices')}</h2>
                        </div>
                        <button type="button" onClick={() => void loadSessions()} disabled={loadingSessions} aria-label={t('rooms.refresh')}><Icon name="refresh" size={28}/></button>
                    </header>
                    <p>{t('profile.loginDevicesHelp')}</p>
                    <div className="session-list" aria-busy={loadingSessions}>
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
                    <footer>
                        <span role="status" aria-live="polite">{sessionMessage}</span>
                        <button type="button" disabled={sessionAction !== null || sessions.every((session) => session.current)} onClick={() => void revokeOthers()}>
                            {t('profile.revokeOthers')}
                        </button>
                    </footer>
                </section>
            </section>
        </PageLayout>
    );
};
