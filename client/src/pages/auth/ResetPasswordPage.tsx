import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../../components/layout/PageLayout.tsx';
import { RoundBox } from '../../components/common/RoundBox.tsx';
import { TextField } from '../../components/common/TextField.tsx';
import { RoundButton } from '../../components/common/RoundButton.tsx';
import { resetPassword, sendVerification } from '../../api/auth.ts';
import { ApiError } from '../../api/http.ts';
import { isEmail, isPassword, isVerificationCode } from '../../utils/validation.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { Color, themeColors } from '../../theme/color.ts';

export const ResetPasswordPage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const theme = useSettingsStore((state) => state.theme);
    const emailRef = useRef<HTMLInputElement>(null);
    const [email, setEmail] = useState('');
    const [code, setCode] = useState('');
    const [password, setPassword] = useState('');
    const [codeSent, setCodeSent] = useState(false);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState(false);

    const sendCode = async () => {
        if (!isEmail(email)) { emailRef.current?.focus(); return; }
        setLoading(true); setMessage(''); setError(false);
        try { await sendVerification(email, 'reset-password'); setCodeSent(true); setMessage(t('auth.codeSent')); }
        catch { setError(true); setMessage(t('auth.serverError')); }
        finally { setLoading(false); }
    };

    const submit = async () => {
        if (!isVerificationCode(code) || !isPassword(password)) return;
        setLoading(true); setMessage(''); setError(false);
        try {
            await resetPassword({ email, code, newPassword: password });
            // 이 화면에 성공 문구를 남겨 봐야 다음에 할 일은 로그인이다. 바로 그리로 보낸다.
            navigate('/login', { replace: true, state: { message: t('auth.resetSuccess') } });
        } catch (requestError) {
            setError(true);
            setMessage(requestError instanceof ApiError && requestError.status === 400
                ? t('auth.invalidCodeServer')
                : t('auth.serverError'));
        } finally { setLoading(false); }
    };

    return (
        <PageLayout title={t('auth.resetTitle')} home settingsDock={false}>
            <RoundBox x={960} y={550} width={1360} height={850} type={2}/>
            <div className="signup-grid" style={{ top: 240 }}>
                <div className="form-row" style={{ gridColumn: '1 / -1' }}>
                    <TextField ref={emailRef} label={t('auth.email')} placeholder={t('auth.emailPlaceholder')} value={email} disabled={codeSent} error={email && !isEmail(email) ? t('auth.invalidEmail') : undefined} onChange={setEmail}/>
                    <RoundButton width={240} height={82} type={2} content={loading && !codeSent ? t('auth.sending') : t('auth.sendCode')} disabled={!isEmail(email) || codeSent} isLoading={loading && !codeSent} onClick={() => void sendCode()}/>
                </div>
                <TextField label={t('auth.code')} placeholder={t('auth.codePlaceholder')} value={code} disabled={!codeSent} maxLength={6} inputMode="numeric" onChange={(value) => setCode(value.replace(/\D/g, ''))}/>
                <TextField label={t('auth.newPassword')} placeholder={t('auth.passwordPlaceholder')} value={password} disabled={!codeSent} type="password" autoComplete="new-password" error={password && !isPassword(password) ? t('auth.invalidPassword') : undefined} onChange={setPassword}/>
                <div className="status-message" role="status" style={{ color: error ? Color.red[2] : themeColors(theme).muted }}>{message || t('auth.resetHelp')}</div>
                <RoundButton width={620} height={104} type={1} content={t('auth.resetAction')} disabled={!isVerificationCode(code) || !isPassword(password)} isLoading={loading && codeSent} onClick={() => void submit()} style={{ justifySelf: 'center' }}/>
            </div>
        </PageLayout>
    );
};
