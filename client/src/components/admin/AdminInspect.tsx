import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/http.ts';
import {
    getAuditLog,
    lookupPlayer,
    type AdminAuditEntry,
    type AdminPlayer,
    type AdminSanction,
} from '../../api/reports.ts';

type LookupState =
    | { kind: 'idle' }
    | { kind: 'busy' }
    | { kind: 'failed'; message: string }
    | { kind: 'found'; player: AdminPlayer; sanctions: AdminSanction[] };

/**
 * 플레이어 조회와 감사 로그.
 *
 * **IP는 없다.** 그 열람에는 별도 권한과 사유가 필요한데 지금 역할은 USER/ADMIN 둘뿐이라 그
 * 통제를 만들 수 없다. 없는 통제를 흉내 내느니 값을 안 보여 주는 쪽이 맞다 — 한 번 뜨기
 * 시작하면 그 뒤로 빼기가 훨씬 어렵다. 그 사실을 화면에도 적어 둔다.
 */
export const AdminInspect: React.FC<{ time: (value: string | number) => string }> = ({ time }) => {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [lookup, setLookup] = useState<LookupState>({ kind: 'idle' });
    const [audit, setAudit] = useState<AdminAuditEntry[]>([]);
    const [nextBefore, setNextBefore] = useState<number | null>(null);
    const [auditBusy, setAuditBusy] = useState(true);

    const loadAudit = useCallback(async (before?: number) => {
        setAuditBusy(true);
        try {
            const page = await getAuditLog(before === undefined ? {} : { before });
            setAudit((current) => (before === undefined ? page.items : [...current, ...page.items]));
            setNextBefore(page.nextBefore);
        } catch {
            // 감사 로그를 못 읽었다고 조회 화면까지 막을 이유는 없다.
        } finally {
            setAuditBusy(false);
        }
    }, []);

    useEffect(() => {
        let active = true;
        void getAuditLog().then((page) => {
            if (!active) return;
            setAudit(page.items);
            setNextBefore(page.nextBefore);
        }).catch(() => undefined).finally(() => {
            if (active) setAuditBusy(false);
        });
        return () => { active = false; };
    }, []);

    const search = async () => {
        const trimmed = query.trim();
        if (!trimmed) return;
        setLookup({ kind: 'busy' });
        try {
            const found = await lookupPlayer(trimmed);
            setLookup({ kind: 'found', ...found });
            // 조회는 감사 로그에 남는다. 방금 남긴 줄이 바로 보이게 다시 읽는다.
            void loadAudit();
        } catch (error) {
            setLookup({
                kind: 'failed',
                message: error instanceof ApiError && error.status === 404
                    ? t('admin.lookupNotFound')
                    : t('admin.lookupFailed'),
            });
        }
    };

    return (
        <div className="admin-inspect">
            <section className="admin-panel" aria-labelledby="admin-lookup-title">
                <header>
                    <h2 id="admin-lookup-title">{t('admin.tabInspect')}</h2>
                    <span>{t('admin.lookupAudited')}</span>
                </header>
                <div className="admin-lookup-form">
                    <input
                        type="text"
                        value={query}
                        placeholder={t('admin.lookupPlaceholder')}
                        aria-label={t('admin.lookupPlaceholder')}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => { if (event.key === 'Enter') void search(); }}
                    />
                    <button type="button" disabled={lookup.kind === 'busy'} onClick={() => void search()}>
                        {t('admin.lookupSearch')}
                    </button>
                </div>
                <p className="admin-lookup-note">{t('admin.lookupNoIp')}</p>

                {lookup.kind === 'failed' && <p className="admin-case-message" data-failed="true" role="alert">{lookup.message}</p>}
                {lookup.kind === 'found' && (
                    <div className="admin-lookup-result">
                        <h3>{lookup.player.nickname} <small>#{lookup.player.userId}</small></h3>
                        <dl>
                            <div><dt>{t('admin.playerStatus')}</dt><dd>{lookup.player.accountStatus}</dd></div>
                            <div><dt>{t('admin.playerJoined')}</dt><dd>{time(lookup.player.createdAt)}</dd></div>
                            <div><dt>{t('admin.playerSessions')}</dt><dd>{lookup.player.activeSessions}</dd></div>
                            <div><dt>{t('admin.playerMatches')}</dt><dd>{lookup.player.matchesPlayed}</dd></div>
                            <div><dt>{t('admin.playerReportsAgainst')}</dt><dd>{lookup.player.reportsAgainst}</dd></div>
                            <div><dt>{t('admin.playerReportsFiled')}</dt><dd>{lookup.player.reportsFiled}</dd></div>
                        </dl>
                        <h4>{t('admin.playerSanctions')}</h4>
                        {lookup.sanctions.length === 0
                            ? <p className="admin-empty">{t('admin.playerNoSanctions')}</p>
                            : (
                                <ul className="admin-sanction-list">
                                    {lookup.sanctions.map((sanction) => (
                                        <li key={sanction.id} data-revoked={sanction.revokedAt ? 'true' : 'false'}>
                                            <strong>{sanction.type}</strong>
                                            <span>{time(sanction.startsAt)}{sanction.expiresAt ? ` → ${time(sanction.expiresAt)}` : ''}</span>
                                            <small>{sanction.reason}</small>
                                            {sanction.revokedAt && <em>{t('admin.sanctionRevoked')}</em>}
                                        </li>
                                    ))}
                                </ul>
                            )}
                    </div>
                )}
            </section>

            <section className="admin-panel" aria-labelledby="admin-audit-title">
                <header>
                    <h2 id="admin-audit-title">{t('admin.auditTitle')}</h2>
                    <span>{t('admin.serverCount', { total: audit.length })}</span>
                </header>
                <div className="admin-table-wrap" tabIndex={0}>
                    <table>
                        <thead>
                            <tr>
                                <th scope="col">{t('admin.colTime')}</th>
                                <th scope="col">{t('admin.colActor')}</th>
                                <th scope="col">{t('admin.colAction')}</th>
                                <th scope="col">{t('admin.colTargetRef')}</th>
                                <th scope="col">{t('admin.colReason')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {audit.length === 0 && (
                                <tr><td colSpan={5}><p className="admin-empty">{t('admin.auditEmpty')}</p></td></tr>
                            )}
                            {audit.map((entry) => (
                                <tr key={entry.id}>
                                    <td><small>{time(entry.createdAt)}</small></td>
                                    <td><small>{entry.actor}</small></td>
                                    <td><strong>{entry.action}</strong></td>
                                    <td><small>{entry.target}</small></td>
                                    <td><small>{entry.reason}</small></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {nextBefore !== null && (
                    <button type="button" className="admin-toggle" disabled={auditBusy} onClick={() => void loadAudit(nextBefore)}>
                        {t('admin.loadMore')}
                    </button>
                )}
            </section>
        </div>
    );
};
