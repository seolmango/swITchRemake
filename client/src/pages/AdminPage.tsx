import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { Icon } from '../components/common/Icon.tsx';
import { getAdminOverview, type AdminOverview } from '../api/admin.ts';
import { useAuthStore } from '../stores/useAuthStore.ts';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { Color, themeColors } from '../theme/color.ts';

/** 자동 갱신 주기. heartbeat가 2초라 그보다 촘촘히 물어봐야 새 값이 나오지 않는다. */
const REFRESH_MS = 4_000;

type State =
    | { kind: 'loading' }
    | { kind: 'denied' }
    | { kind: 'failed' }
    | { kind: 'ready'; overview: AdminOverview };

export const AdminPage: React.FC = () => {
    const { t, i18n } = useTranslation();
    const admin = useAuthStore((store) => store.admin);
    const status = useAuthStore((store) => store.status);
    const theme = useSettingsStore((store) => store.theme);
    const colors = themeColors(theme);
    const [state, setState] = useState<State>({ kind: 'loading' });
    const [live, setLive] = useState(true);
    const inFlight = useRef(false);

    const load = useCallback(async () => {
        // 갱신이 밀리면 요청만 쌓인다. 앞의 것이 끝나기 전에는 새로 보내지 않는다.
        if (inFlight.current) return;
        inFlight.current = true;
        try {
            setState({ kind: 'ready', overview: await getAdminOverview() });
        } catch (error) {
            const denied = typeof error === 'object' && error !== null && 'status' in error
                && (error as { status: number }).status === 403;
            setState(denied ? { kind: 'denied' } : { kind: 'failed' });
        } finally {
            inFlight.current = false;
        }
    }, []);

    useEffect(() => { void load(); }, [load]);
    useEffect(() => {
        if (!live) return;
        const timer = window.setInterval(() => { void load(); }, REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [live, load]);

    const number = (value: number) => new Intl.NumberFormat(i18n.language).format(value);
    const time = (value: string | number) => new Intl.DateTimeFormat(i18n.language, { timeStyle: 'medium' })
        .format(new Date(value));

    // 힌트가 이미 아니라고 말한다. 서버 응답을 기다릴 것 없이 돌려보낸다.
    if (status === 'account' && !admin && state.kind === 'loading') return <AdminDenied/>;
    if (state.kind === 'denied') return <AdminDenied/>;

    return (
        <PageLayout title={t('admin.title')} home>
            <section
                className="admin-shell"
                style={{
                    '--surface': colors.panel,
                    '--surface-border': colors.panelBorder,
                    '--surface-field': colors.field,
                    '--surface-muted': colors.muted,
                    '--admin-text': colors.text,
                    '--admin-good': Color.grass[2],
                    '--admin-warn': Color.frenzy[2],
                    '--admin-bad': Color.red[2],
                } as React.CSSProperties}
            >
                {state.kind !== 'ready' ? (
                    <div className="admin-state" role="status" aria-live="polite">
                        <strong>{t(state.kind === 'failed' ? 'admin.loadFailed' : 'common.loading')}</strong>
                        {state.kind === 'failed' && (
                            <RoundButton width={280} height={72} type={1} content={t('rooms.refresh')} onClick={() => void load()}/>
                        )}
                    </div>
                ) : (
                    <>
                        <div className="admin-kpis">
                            <Kpi label={t('admin.kpiInGame')} value={number(state.overview.players.inGame)} hint={t('admin.kpiInGameHint')}/>
                            <Kpi
                                label={t('admin.kpiRooms')}
                                value={number(state.overview.rooms.total)}
                                hint={t('admin.kpiRoomsHint', {
                                    waiting: number(state.overview.rooms.waiting),
                                    playing: number(state.overview.rooms.playing),
                                })}
                            />
                            <Kpi
                                label={t('admin.kpiGameServers')}
                                value={number(state.overview.gameServers.filter((server) => !server.stale).length)}
                                hint={t('admin.kpiCapacity', { capacity: number(state.overview.rooms.capacity) })}
                            />
                            <Kpi
                                label={t('admin.kpiTraffic')}
                                value={number(state.overview.matchServers.reduce((sum, server) => server.stale ? sum : sum + server.requestsPerMinute, 0))}
                                hint={t('admin.kpiTrafficHint')}
                            />
                            <Kpi
                                label={t('admin.kpiUsers')}
                                value={number(state.overview.users.active)}
                                hint={t('admin.kpiUsersHint', {
                                    sessions: number(state.overview.users.activeSessions),
                                    fresh: number(state.overview.users.newLastDay),
                                })}
                            />
                            <Kpi
                                label={t('admin.kpiMatches')}
                                value={number(state.overview.matches.lastHour)}
                                hint={t('admin.kpiMatchesHint', {
                                    day: number(state.overview.matches.lastDay),
                                    open: number(state.overview.matches.open),
                                })}
                            />
                        </div>

                        {state.overview.registryDegraded && (
                            <p className="admin-degraded" role="alert">{t('admin.registryDegraded')}</p>
                        )}

                        <div className="admin-tables">
                            <section className="admin-panel" aria-labelledby="admin-game-servers">
                                <header>
                                    <h2 id="admin-game-servers">{t('admin.gameServers')}</h2>
                                    <span>{t('admin.serverCount', { total: number(state.overview.gameServers.length) })}</span>
                                </header>
                                <div className="admin-table-wrap" tabIndex={0}>
                                    <table>
                                        <thead>
                                            <tr>
                                                <th scope="col">{t('admin.colServer')}</th>
                                                <th scope="col">{t('admin.colRooms')}</th>
                                                <th scope="col">{t('admin.colConnections')}</th>
                                                <th scope="col">{t('admin.colLag')}</th>
                                                <th scope="col">{t('admin.colState')}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {state.overview.gameServers.map((server) => (
                                                <tr key={server.serverId} className={server.stale ? 'is-stale' : ''}>
                                                    <td>
                                                        <strong>{server.serverId}</strong>
                                                        <small>{server.internalAddress} · {server.buildVersion}</small>
                                                    </td>
                                                    <td>
                                                        <strong>{roomLoad(server.waitingRooms + server.playingRooms, server.maxRooms, number)}</strong>
                                                        <small>{t('admin.roomSplit', { waiting: server.waitingRooms, playing: server.playingRooms })}</small>
                                                    </td>
                                                    <td><strong>{number(server.connections)}</strong></td>
                                                    <td><strong className={lagClass(server.loopLagMs)}>{number(server.loopLagMs)}ms</strong></td>
                                                    <td>
                                                        <ServerBadge
                                                            stale={server.stale}
                                                            draining={server.draining}
                                                            mismatch={server.protocolVersion !== state.overview.protocolVersion}
                                                        />
                                                    </td>
                                                </tr>
                                            ))}
                                            {state.overview.gameServers.length === 0 && (
                                                <tr><td colSpan={5} className="admin-empty">{t('admin.noGameServers')}</td></tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </section>

                            <section className="admin-panel" aria-labelledby="admin-match-servers">
                                <header>
                                    <h2 id="admin-match-servers">{t('admin.matchServers')}</h2>
                                    <span>{t('admin.serverCount', { total: number(state.overview.matchServers.length) })}</span>
                                </header>
                                <div className="admin-table-wrap" tabIndex={0}>
                                    <table>
                                        <thead>
                                            <tr>
                                                <th scope="col">{t('admin.colInstance')}</th>
                                                <th scope="col">{t('admin.colRpm')}</th>
                                                <th scope="col">{t('admin.colPending')}</th>
                                                <th scope="col">{t('admin.colState')}</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {state.overview.matchServers.map((server) => (
                                                <tr key={server.instanceId} className={server.stale ? 'is-stale' : ''}>
                                                    <td>
                                                        <strong>{server.instanceId}</strong>
                                                        <small>{server.buildVersion}</small>
                                                    </td>
                                                    <td><strong>{number(server.requestsPerMinute)}</strong></td>
                                                    <td><strong className={server.pendingCommands >= 20 ? 'is-warn' : ''}>{number(server.pendingCommands)}</strong></td>
                                                    <td>
                                                        <ServerBadge
                                                            stale={server.stale}
                                                            draining={false}
                                                            mismatch={server.protocolVersion !== state.overview.protocolVersion}
                                                        />
                                                    </td>
                                                </tr>
                                            ))}
                                            {state.overview.matchServers.length === 0 && (
                                                <tr><td colSpan={4} className="admin-empty">{t('admin.noMatchServers')}</td></tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </section>
                        </div>

                        <footer className="admin-footer">
                            <span>{t('admin.updatedAt', { time: time(state.overview.generatedAt) })}</span>
                            <div>
                                <button type="button" className="admin-toggle" aria-pressed={live} onClick={() => setLive((value) => !value)}>
                                    <Icon name={live ? 'check' : 'remove'} size={24}/>
                                    {t('admin.autoRefresh')}
                                </button>
                                <RoundButton width={200} height={72} type={1} content={t('rooms.refresh')} onClick={() => void load()}/>
                            </div>
                        </footer>
                    </>
                )}
            </section>
        </PageLayout>
    );
};

/** 상한을 안 실은 서버는 `12/-`가 아니라 그냥 `12`로 적는다. 모르는 값을 0처럼 보이게 하면 안 된다. */
const roomLoad = (used: number, max: number, format: (value: number) => string) =>
    max > 0 ? `${format(used)}/${format(max)}` : format(used);

/** 30Hz 루프라 한 tick이 33ms다. 20ms를 넘으면 여유가 없고 50ms를 넘으면 이미 밀리는 중이다. */
const lagClass = (loopLagMs: number) => loopLagMs >= 50 ? 'is-bad' : loopLagMs >= 20 ? 'is-warn' : '';

const Kpi: React.FC<{ label: string; value: string; hint: string }> = ({ label, value, hint }) => (
    <article className="admin-kpi">
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{hint}</small>
    </article>
);

const ServerBadge: React.FC<{ stale: boolean; draining: boolean; mismatch: boolean }> = ({ stale, draining, mismatch }) => {
    const { t } = useTranslation();
    if (stale) return <em className="admin-badge is-bad">{t('admin.stateStale')}</em>;
    if (mismatch) return <em className="admin-badge is-warn">{t('admin.stateMismatch')}</em>;
    if (draining) return <em className="admin-badge is-warn">{t('admin.stateDraining')}</em>;
    return <em className="admin-badge is-good">{t('admin.stateHealthy')}</em>;
};

const AdminDenied: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    return (
        <PageLayout title={t('admin.title')} home>
            <section className="admin-shell is-denied">
                <div className="admin-state" role="alert">
                    <strong>{t('admin.denied')}</strong>
                    <RoundButton width={280} height={72} type={1} content={t('nav.home')} onClick={() => navigate('/')}/>
                </div>
            </section>
        </PageLayout>
    );
};
