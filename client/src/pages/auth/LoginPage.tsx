import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../../components/layout/PageLayout.tsx';
import { RoundBox } from '../../components/common/RoundBox.tsx';
import { TextField } from '../../components/common/TextField.tsx';
import { InlineLink } from '../../components/common/InlineLink.tsx';
import { RoundButton } from '../../components/common/RoundButton.tsx';
import { Checkbox } from '../../components/common/Checkbox.tsx';
import { useAuthStore } from '../../stores/useAuthStore.ts';
import { isEmail, isPassword } from '../../utils/validation.ts';
import { loginErrorMessage, mfaErrorMessage, retryAfterSeconds } from './authErrorMessage.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { Color, themeColors } from '../../theme/color.ts';
import { resendMfaLoginEmail, type LoginMfaChallenge } from '../../api/auth.ts';
import { deadlineAfterSeconds, useDeadlineSeconds } from '../../utils/deadline.ts';
import { ApiError } from '../../api/http.ts';

export const LoginPage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const login = useAuthStore((state) => state.login);
    const completeMfa = useAuthStore((state) => state.completeMfa);
    const pending = useAuthStore((state) => state.pending);
    const theme = useSettingsStore((state) => state.theme);
    const emailRef = useRef<HTMLInputElement>(null);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [touched, setTouched] = useState(false);
    // 가입·재설정을 마치고 넘어온 안내. 실패 문구와 색을 나눠야 해서 따로 둔다.
    const handoff = (useLocation().state as { message?: string } | null)?.message ?? '';
    const [message, setMessage] = useState('');
    const [messageFailed, setMessageFailed] = useState(false);
    const [challenge, setChallenge] = useState<(LoginMfaChallenge & { expiresAt: number }) | null>(null);
    const [secondFactorCode, setSecondFactorCode] = useState('');
    const [trustDevice, setTrustDevice] = useState(false);
    const [retryDeadline, setRetryDeadline] = useState<number | null>(null);
    const challengeRemaining = useDeadlineSeconds(challenge?.expiresAt ?? null);
    const retryRemaining = useDeadlineSeconds(retryDeadline);
    const valid = isEmail(email) && isPassword(password);

    useEffect(() => { emailRef.current?.focus(); }, []);

    const submit = async () => {
        setTouched(true);
        if (!valid) return;
        setMessage(''); setMessageFailed(false);
        try {
            const nextChallenge = await login(email, password);
            if (nextChallenge) {
                setChallenge({ ...nextChallenge, expiresAt: deadlineAfterSeconds(nextChallenge.expiresIn) });
                setPassword('');
                setSecondFactorCode('');
                setTrustDevice(false);
                setMessage(t(nextChallenge.method === 'email' ? 'auth.mfaEmailSent' : 'auth.mfaTotpPrompt'));
                return;
            }
            navigate('/', { replace: true });
        } catch (error) {
            setMessageFailed(true);
            const seconds = retryAfterSeconds(error);
            if (seconds !== null) setRetryDeadline(deadlineAfterSeconds(seconds));
            setMessage(seconds !== null ? t('auth.retryNow') : loginErrorMessage(error, t));
        }
    };

    const rememberRateLimit = (error: unknown) => {
        const seconds = retryAfterSeconds(error);
        if (seconds !== null) setRetryDeadline(deadlineAfterSeconds(seconds));
    };

    const verifySecondFactor = async () => {
        if (!challenge || !secondFactorCode.trim() || challengeRemaining === 0 || (retryRemaining ?? 0) > 0) return;
        setMessage(''); setMessageFailed(false);
        try {
            await completeMfa(challenge.challengeToken, secondFactorCode.trim(), trustDevice);
            navigate('/', { replace: true });
        } catch (error) {
            setMessageFailed(true);
            rememberRateLimit(error);
            setMessage(mfaErrorMessage(error, t));
            if (error instanceof ApiError && (error.code === 'INVALID_MFA_CHALLENGE' || error.code === 'MFA_LOGIN_RETRY')) {
                setChallenge((current) => current ? { ...current, expiresAt: Date.now() } : current);
            }
        }
    };

    const resendEmailCode = async () => {
        if (!challenge || challenge.method !== 'email' || challengeRemaining === 0 || (retryRemaining ?? 0) > 0) return;
        setMessage(''); setMessageFailed(false);
        try {
            await resendMfaLoginEmail(challenge.challengeToken);
            setMessage(t('auth.mfaEmailResent'));
        } catch (error) {
            setMessageFailed(true);
            rememberRateLimit(error);
            setMessage(mfaErrorMessage(error, t));
        }
    };

    const restartLogin = () => {
        setChallenge(null);
        setSecondFactorCode('');
        setTrustDevice(false);
        setRetryDeadline(null);
        setMessage('');
        setMessageFailed(false);
        window.requestAnimationFrame(() => emailRef.current?.focus());
    };

    return (
        <PageLayout title={t(challenge ? 'auth.mfaTitle' : 'auth.login')} home>
            <RoundBox x={960} y={550} width={1280} height={820} type={2}/>
            {!challenge ? (
                <div className="form-stack" style={{ top: 235 }}>
                    <InlineLink onClick={() => navigate('/signup')} style={{ justifySelf: 'center' }}>{t('auth.goSignup')}</InlineLink>
                    <TextField ref={emailRef} label={t('auth.email')} placeholder={t('auth.emailPlaceholder')} autoComplete="email" inputMode="email" value={email} error={touched && !isEmail(email) ? t('auth.invalidEmail') : undefined} onChange={setEmail}/>
                    <TextField label={t('auth.password')} placeholder={t('auth.passwordPlaceholder')} autoComplete="current-password" type="password" value={password} error={touched && !isPassword(password) ? t('auth.invalidPassword') : undefined} onChange={setPassword}/>
                    <InlineLink onClick={() => navigate('/reset-password')} style={{ justifySelf: 'center' }}>{t('auth.forgot')}</InlineLink>
                    <div className="status-message" role="status" style={{ color: messageFailed ? Color.red[2] : themeColors(theme).muted }}>
                        {(retryRemaining ?? 0) > 0 ? t('auth.rateLimited', { seconds: retryRemaining }) : message || handoff}
                    </div>
                    <RoundButton width={460} height={104} type={1} content={t('auth.login')} disabled={!valid || pending || (retryRemaining ?? 0) > 0} isLoading={pending} onClick={() => void submit()} style={{ justifySelf: 'center' }}/>
                </div>
            ) : (
                <div className="form-stack mfa-login-stack" style={{ top: 225 }}>
                    <p className="mfa-login-prompt">{t(challenge.method === 'email' ? 'auth.mfaEmailPrompt' : 'auth.mfaTotpPrompt')}</p>
                    <TextField
                        label={t('auth.secondFactorCode')}
                        placeholder={t('auth.secondFactorPlaceholder')}
                        autoFocus
                        autoComplete="one-time-code"
                        autoCapitalize="characters"
                        value={secondFactorCode}
                        onChange={setSecondFactorCode}
                    />
                    <Checkbox checked={trustDevice} onChange={setTrustDevice} label={t('auth.trustDevice')}/>
                    <div className="mfa-login-meta">
                        <span>{challengeRemaining === 0 ? t('auth.mfaChallengeExpired') : t('auth.mfaExpiresIn', { seconds: challengeRemaining ?? 0 })}</span>
                        {challenge.method === 'email' && challengeRemaining !== 0 && (retryRemaining ?? 0) === 0 && (
                            <InlineLink onClick={() => void resendEmailCode()} style={{ fontSize: 22 }}>{t('auth.resendCode')}</InlineLink>
                        )}
                    </div>
                    <div className="status-message" role="status" aria-live="polite" style={{ color: messageFailed ? Color.red[2] : themeColors(theme).muted }}>
                        {(retryRemaining ?? 0) > 0 ? t('auth.rateLimited', { seconds: retryRemaining }) : message}
                    </div>
                    <div className="mfa-login-actions">
                        <RoundButton width={330} height={94} type={2} content={t('auth.startOver')} onClick={restartLogin}/>
                        <RoundButton width={420} height={94} type={1} content={t('auth.verify')} disabled={!secondFactorCode.trim() || challengeRemaining === 0 || (retryRemaining ?? 0) > 0 || pending} isLoading={pending} onClick={() => void verifySecondFactor()}/>
                    </div>
                </div>
            )}
        </PageLayout>
    );
};
