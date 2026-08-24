import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../../components/layout/PageLayout.tsx';
import { RoundBox } from '../../components/common/RoundBox.tsx';
import { TextField } from '../../components/common/TextField.tsx';
import { InlineLink } from '../../components/common/InlineLink.tsx';
import { RoundButton } from '../../components/common/RoundButton.tsx';
import { useAuthStore } from '../../stores/useAuthStore.ts';
import { isEmail, isPassword } from '../../utils/validation.ts';
import { ApiError } from '../../api/http.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { Color, themeColors } from '../../theme/color.ts';

export const LoginPage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const login = useAuthStore((state) => state.login);
    const status = useAuthStore((state) => state.status);
    const theme = useSettingsStore((state) => state.theme);
    const emailRef = useRef<HTMLInputElement>(null);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [touched, setTouched] = useState(false);
    const [message, setMessage] = useState('');
    const valid = isEmail(email) && isPassword(password);

    useEffect(() => { emailRef.current?.focus(); }, []);

    const submit = async () => {
        setTouched(true);
        if (!valid) return;
        setMessage('');
        try {
            await login(email, password);
            navigate('/profile', { replace: true });
        } catch (error) {
            setMessage(error instanceof ApiError && error.status === 401 ? t('auth.invalidCredentials') : t('auth.serverError'));
        }
    };

    return (
        <PageLayout title={t('auth.login')} home>
            <RoundBox x={960} y={550} width={1280} height={820} type={2}/>
            <div className="form-stack" style={{ top: 235 }}>
                <InlineLink onClick={() => navigate('/signup')} style={{ justifySelf: 'center' }}>{t('auth.goSignup')}</InlineLink>
                <TextField ref={emailRef} label={t('auth.email')} placeholder={t('auth.emailPlaceholder')} autoComplete="email" inputMode="email" value={email} error={touched && !isEmail(email) ? t('auth.invalidEmail') : undefined} onChange={setEmail}/>
                <TextField label={t('auth.password')} placeholder={t('auth.passwordPlaceholder')} autoComplete="current-password" type="password" value={password} error={touched && !isPassword(password) ? t('auth.invalidPassword') : undefined} onChange={setPassword}/>
                <InlineLink onClick={() => navigate('/reset-password')} style={{ justifySelf: 'center' }}>{t('auth.forgot')}</InlineLink>
                <div className="status-message" role="status" style={{ color: message ? Color.red[2] : themeColors(theme).muted }}>{message}</div>
                <RoundButton width={460} height={104} type={1} content={t('auth.login')} disabled={!valid} isLoading={status === 'booting'} onClick={() => void submit()} style={{ justifySelf: 'center' }}/>
            </div>
        </PageLayout>
    );
};
