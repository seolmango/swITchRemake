import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { Icon } from '../components/common/Icon.tsx';
import { getAdminOverview, type AdminOverview } from '../api/admin.ts';
import { AdminInspect } from '../components/admin/AdminInspect.tsx';
import {
    ALLOWED_REPORT_TRANSITIONS,
    getReportCase,
    getReportQueue,
    REPORT_CATEGORIES,
    sanctionReportCase,
    updateReportStatus,
    type ReportCaseDetail,
    type ReportQueueItem,
    type ReportStatus,
    type SanctionType,
} from '../api/reports.ts';
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

type AdminTab = 'overview' | 'reports' | 'inspect';

interface ReportQueueState {
    items: ReportQueueItem[];
    nextCursor: string | null;
    initialized: boolean;
    loading: boolean;
    failed: boolean;
}

export const AdminPage: React.FC = () => {
    const { t, i18n } = useTranslation();
    const admin = useAuthStore((store) => store.admin);
    const status = useAuthStore((store) => store.status);
    const theme = useSettingsStore((store) => store.theme);
    const colors = themeColors(theme);
    const [state, setState] = useState<State>({ kind: 'loading' });
    const [tab, setTab] = useState<AdminTab>('overview');
    const [live, setLive] = useState(true);
    const [reportQueue, setReportQueue] = useState<ReportQueueState>({
        items: [], nextCursor: null, initialized: false, loading: false, failed: false,
    });
    const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
    const inFlight = useRef(false);
    const reportInFlight = useRef(false);

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

    useEffect(() => {
        const timer = window.setTimeout(() => { void load(); }, 0);
        return () => window.clearTimeout(timer);
    }, [load]);
    useEffect(() => {
        if (!live || tab !== 'overview') return;
        const timer = window.setInterval(() => { void load(); }, REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [live, load, tab]);

    const loadReports = useCallback(async (reset: boolean) => {
        if (reportInFlight.current) return;
        reportInFlight.current = true;
        setReportQueue((current) => ({ ...current, loading: true, failed: false }));
        try {
            const cursor = reset ? undefined : reportQueue.nextCursor ?? undefined;
            const result = await getReportQueue({ cursor });
            setReportQueue((current) => ({
                items: reset ? result.items : [...current.items, ...result.items],
                nextCursor: result.nextCursor,
                initialized: true,
                loading: false,
                failed: false,
            }));
        } catch {
            setReportQueue((current) => ({ ...current, initialized: true, loading: false, failed: true }));
        } finally {
            reportInFlight.current = false;
        }
    }, [reportQueue.nextCursor]);

    const number = (value: number) => new Intl.NumberFormat(i18n.language).format(value);
    const time = (value: string | number) => new Intl.DateTimeFormat(i18n.language, { timeStyle: 'medium' })
        .format(new Date(value));

    // 힌트가 이미 아니라고 말한다. 서버 응답을 기다릴 것 없이 돌려보낸다.
    if (status === 'account' && !admin && state.kind === 'loading') return <AdminDenied/>;
    if (state.kind === 'denied') return <AdminDenied/>;

    return (
        <PageLayout title={t('admin.title')} home>
            <section
                className="admin-shell has-tabs"
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
                <nav className="admin-tabs" aria-label={t('admin.title')}>
                    <button type="button" className="admin-toggle" aria-pressed={tab === 'overview'} onClick={() => setTab('overview')}>
                        {t('admin.tabOverview')}
                    </button>
                    <button
                        type="button"
                        className="admin-toggle"
                        aria-pressed={tab === 'reports'}
                        onClick={() => {
                            setTab('reports');
                            if (!reportQueue.initialized) void loadReports(true);
                        }}
                    >
                        {t('admin.tabReports')}
                    </button>
                    <button type="button" className="admin-toggle" aria-pressed={tab === 'inspect'} onClick={() => setTab('inspect')}>
                        {t('admin.tabInspect')}
                    </button>
                </nav>

                {tab === 'overview' ? (
                    state.kind !== 'ready' ? (
                        <div className="admin-state" role="status" aria-live="polite">
                            <strong>{t(state.kind === 'failed' ? 'admin.loadFailed' : 'common.loading')}</strong>
                            {state.kind === 'failed' && (
                                <RoundButton width={280} height={72} type={1} content={t('rooms.refresh')} onClick={() => void load()}/>
                            )}
                        </div>
                    ) : (
                    <div className={`admin-overview${state.overview.registryDegraded ? ' has-degraded' : ''}`}>
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
                    </div>
                    )
                ) : tab === 'inspect' ? (
                    <AdminInspect time={time}/>
                ) : (
                    <ReportQueue
                        state={reportQueue}
                        number={number}
                        time={time}
                        onOpen={setSelectedCaseId}
                        onNext={() => void loadReports(false)}
                        onRefresh={() => void loadReports(true)}
                    />
                )}

                {selectedCaseId && (
                    <ReportCaseDialog
                        caseId={selectedCaseId}
                        time={time}
                        onClose={() => setSelectedCaseId(null)}
                        onChanged={() => void loadReports(true)}
                    />
                )}
            </section>
        </PageLayout>
    );
};

type CaseState =
    | { kind: 'loading' }
    | { kind: 'failed' }
    | { kind: 'ready'; detail: ReportCaseDetail };

interface ReportCaseDialogProps {
    caseId: string;
    time: (value: string | number) => string;
    onClose: () => void;
    onChanged: () => void;
}

const ReportCaseDialog: React.FC<ReportCaseDialogProps> = ({ caseId, time, onClose, onChanged }) => {
    const { t } = useTranslation();
    const colors = themeColors(useSettingsStore((store) => store.theme));
    const [state, setState] = useState<CaseState>({ kind: 'loading' });
    const [nextStatus, setNextStatus] = useState<ReportStatus>('TRIAGED');
    const [note, setNote] = useState('');
    const [sanctionType, setSanctionType] = useState<SanctionType>('WARN');
    const [sanctionDays, setSanctionDays] = useState('');
    const [sanctionReason, setSanctionReason] = useState('');
    const [statusBusy, setStatusBusy] = useState(false);
    const [sanctionBusy, setSanctionBusy] = useState(false);
    const [actionMessage, setActionMessage] = useState('');
    const [actionFailed, setActionFailed] = useState(false);
    const [sanctionMessage, setSanctionMessage] = useState('');
    const [sanctionFailed, setSanctionFailed] = useState(false);

    useEffect(() => {
        let active = true;
        void getReportCase(caseId).then((detail) => {
            if (!active) return;
            setState({ kind: 'ready', detail });
            setNote(detail.note ?? '');
            setNextStatus(ALLOWED_REPORT_TRANSITIONS[detail.status][0] ?? detail.status);
        }).catch(() => {
            if (active) setState({ kind: 'failed' });
        });
        return () => { active = false; };
    }, [caseId]);

    const applyStatus = async (detail: ReportCaseDetail) => {
        if (statusBusy || nextStatus === detail.status) return;
        setStatusBusy(true); setActionFailed(false); setActionMessage('');
        try {
            const result = await updateReportStatus(caseId, { status: nextStatus, note: note.trim() });
            setState({ kind: 'ready', detail: { ...detail, status: result.status, note: note.trim() || null } });
            setNextStatus(ALLOWED_REPORT_TRANSITIONS[result.status][0] ?? result.status);
            onChanged();
        } catch {
            setActionFailed(true);
            setActionMessage(t('admin.actionFailed'));
        } finally {
            setStatusBusy(false);
        }
    };

    const days = sanctionDays === '' ? undefined : Number(sanctionDays);
    const validDays = sanctionType === 'WARN' || days === undefined || (Number.isInteger(days) && days > 0);
    const sanctionReady = sanctionReason.trim().length >= 10 && validDays;

    const applySanction = async (detail: ReportCaseDetail) => {
        if (detail.target.kind === 'guest' || sanctionBusy || !sanctionReady) return;
        setSanctionBusy(true); setSanctionFailed(false); setSanctionMessage('');
        try {
            const result = await sanctionReportCase(caseId, {
                type: sanctionType,
                days: sanctionType === 'WARN' ? undefined : days,
                reason: sanctionReason.trim(),
            });
            setState({ kind: 'ready', detail: { ...detail, status: result.status } });
            setNextStatus(ALLOWED_REPORT_TRANSITIONS[result.status][0] ?? result.status);
            setSanctionMessage(t('admin.sanctionDone'));
            onChanged();
        } catch {
            setSanctionFailed(true);
            setSanctionMessage(t('admin.actionFailed'));
        } finally {
            setSanctionBusy(false);
        }
    };

    return (
        <div
            className="lobby-dialog-backdrop"
            role="presentation"
            style={{
                '--surface': colors.panel === 'transparent' ? colors.canvas : colors.panel,
                '--surface-border': colors.panelBorder,
                '--surface-muted': colors.muted,
                color: colors.text,
            } as React.CSSProperties}
            onMouseDown={(event) => event.target === event.currentTarget && onClose()}
        >
            <section
                className="lobby-dialog admin-case-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="admin-case-title"
                onKeyDown={(event) => event.key === 'Escape' && onClose()}
            >
                {state.kind === 'loading' && <p role="status">{t('common.loading')}</p>}
                {state.kind === 'failed' && <p role="alert" className="is-bad">{t('admin.reportsLoadFailed')}</p>}
                {state.kind === 'ready' && (
                    <>
                        <header className="admin-case-header">
                            <div>
                                <h2 id="admin-case-title">{t('admin.caseTitle', { nickname: state.detail.target.nickname })}</h2>
                                {state.detail.target.kind === 'guest' && <em className="admin-badge is-warn">{t('admin.guestBadge')}</em>}
                            </div>
                            <ReportStatusBadge status={state.detail.status}/>
                        </header>

                        <div className="admin-case-summary">
                            <p>{t('admin.caseMatch', {
                                mapId: state.detail.match.mapId,
                                endedAt: state.detail.match.endedAt ? time(state.detail.match.endedAt) : '—',
                            })}</p>
                            <p>{t(state.detail.replay?.held ? 'admin.caseReplayHeld' : 'admin.caseReplayGone')}</p>
                        </div>

                        <section className="admin-case-section admin-case-reporters" aria-labelledby="admin-case-reporters">
                            <h3 id="admin-case-reporters">{t('admin.caseReporters')}</h3>
                            <div>
                                {state.detail.reports.map((report, index) => (
                                    <article key={`${report.reporter.userId}-${report.createdAt}-${index}`}>
                                        <header>
                                            <strong>{report.reporter.nickname}</strong>
                                            <span>{t(`report.categories.${report.category}`)}</span>
                                            {report.tick !== null && <span>{t('admin.caseTick', { tick: report.tick })}</span>}
                                            <time>{time(report.createdAt)}</time>
                                        </header>
                                        <p>{report.description}</p>
                                    </article>
                                ))}
                            </div>
                        </section>

                        <CaseActions
                            detail={state.detail}
                            nextStatus={nextStatus}
                            note={note}
                            sanctionType={sanctionType}
                            sanctionDays={sanctionDays}
                            sanctionReason={sanctionReason}
                            statusBusy={statusBusy}
                            sanctionBusy={sanctionBusy}
                            sanctionReady={sanctionReady}
                            actionMessage={actionMessage}
                            actionFailed={actionFailed}
                            sanctionMessage={sanctionMessage}
                            sanctionFailed={sanctionFailed}
                            onNextStatus={setNextStatus}
                            onNote={setNote}
                            onSanctionType={setSanctionType}
                            onSanctionDays={setSanctionDays}
                            onSanctionReason={setSanctionReason}
                            onApplyStatus={() => void applyStatus(state.detail)}
                            onApplySanction={() => void applySanction(state.detail)}
                        />
                    </>
                )}
                <div className="lobby-dialog-actions">
                    <button type="button" onClick={onClose}>{t('nav.back')}</button>
                </div>
            </section>
        </div>
    );
};

interface CaseActionsProps {
    detail: ReportCaseDetail;
    nextStatus: ReportStatus;
    note: string;
    sanctionType: SanctionType;
    sanctionDays: string;
    sanctionReason: string;
    statusBusy: boolean;
    sanctionBusy: boolean;
    sanctionReady: boolean;
    actionMessage: string;
    actionFailed: boolean;
    sanctionMessage: string;
    sanctionFailed: boolean;
    onNextStatus: (status: ReportStatus) => void;
    onNote: (note: string) => void;
    onSanctionType: (type: SanctionType) => void;
    onSanctionDays: (days: string) => void;
    onSanctionReason: (reason: string) => void;
    onApplyStatus: () => void;
    onApplySanction: () => void;
}

const CaseActions: React.FC<CaseActionsProps> = (props) => {
    const { t } = useTranslation();
    return (
        <div className="admin-case-actions-grid">
            <section className="admin-case-section" aria-labelledby="admin-case-status-change">
                <h3 id="admin-case-status-change">{t('admin.caseStatusChange')}</h3>
                {/* 갈 수 있는 곳만 보여 준다. 서버가 거절할 것을 메뉴에 두면 운영자는 고르고 나서야 안다. */}
                <select value={props.nextStatus} onChange={(event) => props.onNextStatus(event.target.value as ReportStatus)}>
                    {ALLOWED_REPORT_TRANSITIONS[props.detail.status].map((status) => (
                        <option key={status} value={status}>{t(`admin.reportStatus.${status}`)}</option>
                    ))}
                </select>
                <label>
                    <span>{t('admin.caseNote')}</span>
                    <textarea rows={3} value={props.note} onChange={(event) => props.onNote(event.target.value)}/>
                </label>
                <p className="admin-case-message" role="status" data-failed={props.actionFailed ? 'true' : 'false'}>{props.actionMessage}</p>
                <button type="button" className="is-status" disabled={props.statusBusy} onClick={props.onApplyStatus}>
                    {t('admin.caseApply')}
                </button>
            </section>

            <section className="admin-case-section" aria-labelledby="admin-case-sanction">
                <h3 id="admin-case-sanction">{t('admin.caseSanction')}</h3>
                {props.detail.target.kind === 'guest' ? (
                    <p className="admin-sanction-guest">{t('admin.sanctionGuestBlocked')}</p>
                ) : (
                    <>
                        <select value={props.sanctionType} onChange={(event) => props.onSanctionType(event.target.value as SanctionType)}>
                            {(['WARN', 'GAME_RESTRICT', 'BAN'] as const).map((type) => (
                                <option key={type} value={type}>{t(`admin.sanctionType.${type}`)}</option>
                            ))}
                        </select>
                        {props.sanctionType !== 'WARN' && (
                            <label>
                                <span>{t('admin.sanctionDays')}</span>
                                <input
                                    type="number"
                                    min={1}
                                    step={1}
                                    placeholder={t('admin.sanctionDaysHint')}
                                    value={props.sanctionDays}
                                    onChange={(event) => props.onSanctionDays(event.target.value)}
                                />
                            </label>
                        )}
                        <label>
                            <span>{t('admin.sanctionReason')}</span>
                            <textarea minLength={10} required rows={3} value={props.sanctionReason} onChange={(event) => props.onSanctionReason(event.target.value)}/>
                        </label>
                        <p className="admin-case-message" role="status" data-failed={props.sanctionFailed ? 'true' : 'false'}>{props.sanctionMessage}</p>
                        <button
                            type="button"
                            className="is-sanction"
                            disabled={!props.sanctionReady || props.sanctionBusy}
                            onClick={props.onApplySanction}
                        >
                            {t('admin.sanctionApply')}
                        </button>
                    </>
                )}
            </section>
        </div>
    );
};

interface ReportQueueProps {
    state: ReportQueueState;
    number: (value: number) => string;
    time: (value: string | number) => string;
    onOpen: (caseId: string) => void;
    onNext: () => void;
    onRefresh: () => void;
}

const ReportQueue: React.FC<ReportQueueProps> = ({ state, number, time, onOpen, onNext, onRefresh }) => {
    const { t } = useTranslation();

    return (
        <div className="admin-reports">
            <section className="admin-panel admin-report-panel" aria-labelledby="admin-report-queue">
                <header>
                    <h2 id="admin-report-queue">{t('admin.reportsTitle')}</h2>
                    <span>{t('admin.serverCount', { total: number(state.items.length) })}</span>
                </header>
                <div className="admin-table-wrap" tabIndex={0}>
                    <table>
                        <thead>
                            <tr>
                                <th scope="col">{t('admin.colTarget')}</th>
                                <th scope="col">{t('admin.colReports')}</th>
                                <th scope="col">{t('admin.colCategories')}</th>
                                <th scope="col">{t('admin.colState')}</th>
                                <th scope="col">{t('admin.colUpdated')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {state.items.map((item) => {
                                const categories = REPORT_CATEGORIES
                                    .filter((category) => item.categories[category] > 0)
                                    .map((category) => `${t(`report.categories.${category}`)} ${number(item.categories[category])}`)
                                    .join(' · ');
                                return (
                                    <tr
                                        key={item.caseId}
                                        className="admin-report-row"
                                        tabIndex={0}
                                        onClick={() => onOpen(item.caseId)}
                                        onKeyDown={(event) => {
                                            if (event.key !== 'Enter' && event.key !== ' ') return;
                                            event.preventDefault();
                                            onOpen(item.caseId);
                                        }}
                                    >
                                        <td>
                                            <strong className="admin-report-target">
                                                <span>{item.target.nickname}</span>
                                                {item.target.kind === 'guest' && <em className="admin-badge is-warn">{t('admin.guestBadge')}</em>}
                                            </strong>
                                        </td>
                                        <td><strong>{number(item.reportCount)}</strong></td>
                                        <td><span className="admin-report-categories">{categories || '—'}</span></td>
                                        <td><ReportStatusBadge status={item.status}/></td>
                                        <td><span className="admin-report-time">{item.latestReportedAt ? time(item.latestReportedAt) : '—'}</span></td>
                                    </tr>
                                );
                            })}
                            {state.failed && (
                                <tr><td colSpan={5} className="admin-empty is-bad">{t('admin.reportsLoadFailed')}</td></tr>
                            )}
                            {state.loading && (
                                <tr><td colSpan={5} className="admin-empty">{t('common.loading')}</td></tr>
                            )}
                            {state.initialized && !state.loading && !state.failed && state.items.length === 0 && (
                                <tr><td colSpan={5} className="admin-empty">{t('admin.reportsEmpty')}</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </section>
            <footer className="admin-report-footer">
                {state.failed && (
                    <button type="button" className="admin-toggle" onClick={onRefresh}>{t('rooms.refresh')}</button>
                )}
                {state.nextCursor && !state.failed && (
                    <button type="button" className="admin-toggle" disabled={state.loading} onClick={onNext}>
                        {t('nav.nextPage')}
                    </button>
                )}
            </footer>
        </div>
    );
};

const ReportStatusBadge: React.FC<{ status: ReportStatus }> = ({ status }) => {
    const { t } = useTranslation();
    const tone = status === 'OPEN' ? 'is-bad'
        : status === 'TRIAGED' || status === 'REVIEWING' ? 'is-warn'
            : 'is-good';
    return <em className={`admin-badge ${tone}`}>{t(`admin.reportStatus.${status}`)}</em>;
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
