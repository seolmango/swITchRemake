import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../common/Icon.tsx';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { themeColors } from '../../theme/color.ts';
import { ApiError } from '../../api/http.ts';
import { deleteMyAccount, sendDeleteCode } from '../../api/profile.ts';
import { isVerificationCode } from '../../utils/validation.ts';

/**
 * 회원 탈퇴.
 *
 * 되돌릴 수 없는 일이라 두 단계를 거친다 — 메일로 온 코드를 넣어야 버튼이 열린다. 비밀번호로
 * 확인하지 않는 이유는, 남이 잠깐 자리를 비운 사이 브라우저를 만지는 상황이 이 화면의 주된
 * 위험이고 그때 비밀번호는 이미 필요 없기 때문이다. 코드는 계정 주인의 메일함에만 간다.
 */
export const DeleteAccountDialog: React.FC<{ onClose: () => void; onDeleted: () => void }> = ({ onClose, onDeleted }) => {
    const { t } = useTranslation();
    const colors = themeColors(useSettingsStore((state) => state.theme));
    const [code, setCode] = useState('');
    const [codeSent, setCodeSent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [failed, setFailed] = useState(false);

    const requestCode = async () => {
        setBusy(true); setFailed(false); setMessage('');
        try {
            await sendDeleteCode();
            setCodeSent(true);
            setMessage(t('profile.deleteCodeSent'));
        } catch {
            setFailed(true);
            setMessage(t('auth.serverError'));
        } finally { setBusy(false); }
    };

    const confirm = async () => {
        if (!isVerificationCode(code)) return;
        setBusy(true); setFailed(false); setMessage('');
        try {
            await deleteMyAccount(code);
            onDeleted();
        } catch (error) {
            setFailed(true);
            setMessage(error instanceof ApiError && error.status === 400
                ? t('auth.invalidCodeServer')
                : t('profile.deleteFailed'));
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

                <p className="delete-dialog-message" role="status" aria-live="polite" data-failed={failed ? 'true' : 'false'}>{message}</p>

                <div className="lobby-dialog-actions">
                    <button type="button" onClick={onClose}>{t('common.cancel')}</button>
                    {codeSent ? (
                        <button type="button" className="is-danger" disabled={busy || !isVerificationCode(code)} onClick={() => void confirm()}>
                            {t('profile.deleteConfirm')}
                        </button>
                    ) : (
                        <button type="button" className="is-danger" disabled={busy} onClick={() => void requestCode()}>
                            {t('profile.deleteSendCode')}
                        </button>
                    )}
                </div>
            </section>
        </div>
    );
};
