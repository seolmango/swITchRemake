import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../common/Icon.tsx';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { themeColors } from '../../theme/color.ts';
import { ApiError } from '../../api/http.ts';
import { deleteMyAccount, sendDeleteCode } from '../../api/profile.ts';
import { isVerificationCode } from '../../utils/validation.ts';
import { getMfaStatus, type MfaMethod } from '../../api/mfa.ts';
import { mfaErrorMessage, retryAfterSeconds } from '../../pages/auth/authErrorMessage.ts';
import { deadlineAfterSeconds, useDeadlineSeconds } from '../../utils/deadline.ts';

/**
 * 회원 탈퇴.
 *
 * 되돌릴 수 없는 일이라 메일 코드를 먼저 받는다. TOTP 계정은 인증 앱 코드나 백업 코드도
 * 별도로 확인한다. 메일 MFA 계정은 탈퇴 메일 코드가 서버에서 2차 확인을 겸한다.
 */
export const DeleteAccountDialog: React.FC<{ onClose: () => void; onDeleted: () => void }> = ({ onClose, onDeleted }) => {
    const { t } = useTranslation();
    const colors = themeColors(useSettingsStore((state) => state.theme));
    const [code, setCode] = useState('');
    const [codeSent, setCodeSent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [failed, setFailed] = useState(false);
    const [mfaMethod, setMfaMethod] = useState<MfaMethod | null>(null);
    const [secondFactorCode, setSecondFactorCode] = useState('');
    const [retryDeadline, setRetryDeadline] = useState<number | null>(null);
    const retryRemaining = useDeadlineSeconds(retryDeadline);

    useEffect(() => {
        let active = true;
        void getMfaStatus().then((result) => {
            if (active) setMfaMethod(result.method);
        }).catch(() => undefined);
        return () => { active = false; };
    }, []);

    const rememberRateLimit = (error: unknown) => {
        const seconds = retryAfterSeconds(error);
        if (seconds !== null) setRetryDeadline(deadlineAfterSeconds(seconds));
        return seconds;
    };

    const requestCode = async () => {
        setBusy(true); setFailed(false); setMessage('');
        try {
            await sendDeleteCode();
            setCodeSent(true);
            setMessage(t('profile.deleteCodeSent'));
        } catch (error) {
            const retrySeconds = rememberRateLimit(error);
            setFailed(true);
            setMessage(retrySeconds !== null ? t('auth.retryNow') : t('auth.serverError'));
        } finally { setBusy(false); }
    };

    const confirm = async () => {
        if (!isVerificationCode(code) || (mfaMethod === 'totp' && !secondFactorCode.trim()) || (retryRemaining ?? 0) > 0) return;
        setBusy(true); setFailed(false); setMessage('');
        try {
            await deleteMyAccount(code, mfaMethod === 'totp' ? secondFactorCode.trim() : undefined);
            onDeleted();
        } catch (error) {
            const retrySeconds = rememberRateLimit(error);
            setFailed(true);
            if (error instanceof ApiError && error.code === 'MFA_REQUIRED') {
                setMfaMethod('totp');
                setMessage(t('profile.deleteMfaRequired'));
            } else if (error instanceof ApiError && error.code === 'INVALID_SECOND_FACTOR') {
                setMessage(mfaErrorMessage(error, t));
            } else {
                setMessage(error instanceof ApiError && error.status === 400
                    ? t('auth.invalidCodeServer')
                    : retrySeconds !== null
                        ? t('auth.retryNow')
                        : t('profile.deleteFailed'));
            }
            setBusy(false);
        }
    };

    return (
        <div
            className="lobby-dialog-backdrop"
            role="presentation"
            /* 대화상자 껍데기는 로비 것을 그대로 쓴다. 색 변수는 로비 화면이 채워 주던 것이라 여기서 채운다. */
            style={{
                '--surface': colors.panel === 'transparent' ? colors.canvas : colors.panel,
                '--surface-border': colors.panelBorder,
                '--surface-muted': colors.muted,
                color: colors.text,
            } as React.CSSProperties}
            onMouseDown={(event) => event.target === event.currentTarget && onClose()}
        >
            <section
                className="lobby-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="delete-dialog-title"
                aria-describedby="delete-dialog-body"
                onKeyDown={(event) => event.key === 'Escape' && onClose()}
            >
                <Icon name="remove" size={52}/>
                <h2 id="delete-dialog-title">{t('profile.deleteTitle')}</h2>
                <p id="delete-dialog-body">{t('profile.deleteBody')}</p>

                {codeSent && (
                    <label className="delete-code-field">
                        <span>{t('auth.code')}</span>
                        <input
                            type="text"
                            inputMode="numeric"
                            maxLength={6}
                            autoFocus
                            value={code}
                            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                        />
                    </label>
                )}

                {codeSent && mfaMethod === 'totp' && (
                    <label className="delete-code-field is-second-factor">
                        <span>{t('auth.secondFactorCode')}</span>
                        <input
                            type="text"
                            autoComplete="one-time-code"
                            placeholder={t('auth.secondFactorPlaceholder')}
                            value={secondFactorCode}
                            onChange={(event) => setSecondFactorCode(event.target.value)}
                        />
                    </label>
                )}

                <p className="delete-dialog-message" role="status" aria-live="polite" data-failed={failed ? 'true' : 'false'}>
                    {(retryRemaining ?? 0) > 0 ? t('auth.rateLimited', { seconds: retryRemaining }) : message}
                </p>

                <div className="lobby-dialog-actions">
                    <button type="button" onClick={onClose}>{t('common.cancel')}</button>
                    {codeSent ? (
                        <button type="button" className="is-danger" disabled={busy || !isVerificationCode(code) || (mfaMethod === 'totp' && !secondFactorCode.trim()) || (retryRemaining ?? 0) > 0} onClick={() => void confirm()}>
                            {t('profile.deleteConfirm')}
                        </button>
                    ) : (
                        <button type="button" className="is-danger" disabled={busy || (retryRemaining ?? 0) > 0} onClick={() => void requestCode()}>
                            {t('profile.deleteSendCode')}
                        </button>
                    )}
                </div>
            </section>
        </div>
    );
};
