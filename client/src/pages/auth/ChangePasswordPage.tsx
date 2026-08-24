import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../../components/layout/PageLayout.tsx';
import { RoundBox } from '../../components/common/RoundBox.tsx';
import { TextField } from '../../components/common/TextField.tsx';
import { RoundButton } from '../../components/common/RoundButton.tsx';
import { isPassword } from '../../utils/validation.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { themeColors } from '../../theme/color.ts';
import { changePassword } from '../../api/auth.ts';
import { ApiError } from '../../api/http.ts';
import { Color } from '../../theme/color.ts';

export const ChangePasswordPage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const theme = useSettingsStore((state) => state.theme);
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newPasswordConfirmation, setNewPasswordConfirmation] = useState('');
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(false);
    const [failed, setFailed] = useState(false);
    const valid = isPassword(currentPassword)
        && isPassword(newPassword)
        && newPassword === newPasswordConfirmation;

    const submit = async () => {
        if (!valid) return;
        setLoading(true); setFailed(false); setMessage('');
        try {
            const result = await changePassword({ currentPassword, newPassword });
            setCurrentPassword(''); setNewPassword(''); setNewPasswordConfirmation('');
            setMessage(t('auth.changeSuccess', { count: result.revokedCount }));
        } catch (error) {
            setFailed(true);
            setMessage(error instanceof ApiError && error.status === 401
                ? t('auth.currentPasswordIncorrect')
                : error instanceof ApiError && error.status === 400
                    ? t('auth.changeInvalid')
                    : t('auth.changeFailed'));
        } finally {
            setLoading(false);
        }
    };
    return (
        <PageLayout title={t('auth.changeTitle')} backTo="/profile">
            <RoundBox x={960} y={550} width={1240} height={800} type={2}/>
            <div className="form-stack" style={{ top: 285 }}>
                <TextField label={t('auth.currentPassword')} value={currentPassword} type="password" autoComplete="current-password" onChange={setCurrentPassword}/>
                <TextField label={t('auth.newPassword')} placeholder={t('auth.passwordPlaceholder')} value={newPassword} type="password" autoComplete="new-password" onChange={setNewPassword}/>
                <TextField label={t('auth.confirmNewPassword')} placeholder={t('auth.passwordPlaceholder')} value={newPasswordConfirmation} type="password" autoComplete="new-password" error={newPasswordConfirmation && newPassword !== newPasswordConfirmation ? t('auth.passwordMismatch') : undefined} onChange={setNewPasswordConfirmation}/>
                <div className="status-message" role="status" aria-live="polite" style={{ color: failed ? Color.red[2] : themeColors(theme).muted }}>{message}</div>
                <RoundButton width={620} height={104} type={1} content={t('auth.changeTitle')} disabled={!valid || loading} isLoading={loading} onClick={() => void submit()} style={{ justifySelf: 'center' }}/>
                <RoundButton width={360} height={86} type={2} content={t('nav.back')} onClick={() => navigate('/profile')} style={{ justifySelf: 'center' }}/>
            </div>
        </PageLayout>
    );
};
