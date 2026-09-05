import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../common/Icon.tsx';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { themeColors } from '../../theme/color.ts';
import { ApiError } from '../../api/http.ts';
import { createReport, REPORT_CATEGORIES, type ReportCategory } from '../../api/reports.ts';
import { useModalFocusTrap } from '../common/useModalFocusTrap.ts';

const MIN_DESCRIPTION = 10;
const MAX_DESCRIPTION = 500;

/** 서버가 이유를 코드로 준다. 코드를 그대로 보여 주면 아무도 못 읽으므로 문장으로 바꾼다. */
function messageFor(error: unknown, t: (key: string) => string): string {
    const code = error instanceof ApiError ? error.code : null;
    switch (code) {
        case 'DUPLICATE_REPORT': return t('report.errors.duplicate');
        case 'REPLAY_UNAVAILABLE':
        case 'REPORT_WINDOW_EXPIRED': return t('report.errors.window');
        case 'INVALID_REPORT_TARGET':
        case 'REPORTER_NOT_MATCH_PARTICIPANT': return t('report.errors.target');
        case 'SELF_REPORT': return t('report.errors.self');
        default: return t('report.errors.failed');
    }
}

interface Props {
    matchId: string;
    target: { playerId: number; nickname: string; isGuest: boolean };
    onClose: () => void;
}

/**
 * 경기 결과 화면에서 여는 신고.
 *
 * 대상은 **경기 안의 자리 번호**로만 보낸다 — 계정인지 게스트인지는 서버가 명단을 보고 정한다.
 * 화면이 남의 계정 id를 알 필요가 없다.
 *
 * 분류를 먼저 고르게 하는 이유는 설명이 비어 있어도 무엇을 신고했는지는 남기기 위해서다. 다만
 * 설명 없이 받은 신고는 조사할 수 없어서 최소 길이를 둔다.
 */
export const ReportDialog: React.FC<Props> = ({ matchId, target, onClose }) => {
    const { t } = useTranslation();
    const colors = themeColors(useSettingsStore((state) => state.theme));
    const [category, setCategory] = useState<ReportCategory | null>(null);
    const [description, setDescription] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [failed, setFailed] = useState(false);
    const [sent, setSent] = useState(false);
    const { dialogRef, onDialogKeyDown } = useModalFocusTrap<HTMLElement>(onClose);

    const ready = category !== null && description.trim().length >= MIN_DESCRIPTION;

    const submit = async () => {
        if (!ready || busy) return;
        setBusy(true); setFailed(false); setMessage('');
        try {
            await createReport({ matchId, targetPlayerId: target.playerId, category, description: description.trim() });
            setSent(true);
            setMessage(t('report.sent'));
        } catch (error) {
            setFailed(true);
            setMessage(messageFor(error, t));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div
            className="lobby-dialog-backdrop"
            role="presentation"
            /* 대화상자 껍데기는 로비 것을 그대로 쓴다. 색 변수는 로비 화면이 채워 주던 것이다. */
            style={{
                '--surface': colors.panel === 'transparent' ? colors.canvas : colors.panel,
                '--surface-border': colors.panelBorder,
                '--surface-muted': colors.muted,
                color: colors.text,
            } as React.CSSProperties}
            onMouseDown={(event) => event.target === event.currentTarget && onClose()}
        >
            <section
                ref={dialogRef}
                className="lobby-dialog is-report-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="report-dialog-title"
                tabIndex={-1}
                onKeyDown={onDialogKeyDown}
            >
                <Icon name="flag" size={44}/>
                <h2 id="report-dialog-title">{t('report.title', { nickname: target.nickname })}</h2>
                <p>{t('report.notice')}</p>
                {target.isGuest && <p className="report-guest-notice">{t('report.guestNotice')}</p>}

                {!sent && (
                    <>
                        <fieldset className="report-categories">
                            <legend>{t('report.categoryLabel')}</legend>
                            {REPORT_CATEGORIES.map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    aria-pressed={category === value}
                                    onClick={() => setCategory(value)}
                                >
                                    {t(`report.categories.${value}`)}
                                </button>
                            ))}
                        </fieldset>

                        <label className="report-description">
                            <span>{t('report.descriptionLabel')}</span>
                            <textarea
                                rows={4}
                                maxLength={MAX_DESCRIPTION}
                                placeholder={t('report.descriptionPlaceholder')}
                                value={description}
                                onChange={(event) => setDescription(event.target.value)}
                            />
                            <small>{t('report.descriptionHint', { count: description.length })}</small>
                        </label>
                    </>
                )}

                <p className="delete-dialog-message" role="status" aria-live="polite" data-failed={failed ? 'true' : 'false'}>{message}</p>

                <div className="lobby-dialog-actions">
                    {/* 보낸 뒤에는 '취소'가 아니라 '닫기'다. 그리고 화면의 뒤로 가기와 이름이 겹치면 안 된다. */}
                    <button type="button" onClick={onClose}>{sent ? t('common.close') : t('common.cancel')}</button>
                    {!sent && (
                        <button type="button" className="is-danger" disabled={!ready || busy} onClick={() => void submit()}>
                            {t('report.submit')}
                        </button>
                    )}
                </div>
            </section>
        </div>
    );
};
