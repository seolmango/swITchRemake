import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../../components/layout/PageLayout.tsx';
import { RoundBox } from '../../components/common/RoundBox.tsx';
import { TextField } from '../../components/common/TextField.tsx';
import { InlineLink } from '../../components/common/InlineLink.tsx';
import { RoundButton } from '../../components/common/RoundButton.tsx';
import { registerUser, sendVerification } from '../../api/auth.ts';
import { ApiError } from '../../api/http.ts';
import { isEmail, isNickname, isPassword, isVerificationCode } from '../../utils/validation.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { themeColors } from '../../theme/color.ts';
import { Checkbox } from '../../components/common/Checkbox.tsx';
import { LegalDocumentDialog } from '../../components/legal/LegalDialogs.tsx';
import {
    hasRequiredAgreements,
    PRIVACY_POLICY,
    registrationAgreements,
    TERMS_OF_SERVICE,
    type LegalDocument,
} from '../../legal/legalDocuments.ts';

export const SignUpPage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const theme = useSettingsStore((state) => state.theme);
    const emailRef = useRef<HTMLInputElement>(null);
    const [email, setEmail] = useState('');
    const [nickname, setNicknameValue] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [codeSent, setCodeSent] = useState(false);
    const [loading, setLoading] = useState(false);
    const [touched, setTouched] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState(false);
    const [termsAcceptedAt, setTermsAcceptedAt] = useState<string | null>(null);
    const [privacyAcceptedAt, setPrivacyAcceptedAt] = useState<string | null>(null);
    const [openDocument, setOpenDocument] = useState<LegalDocument | null>(null);
    const agreementsAccepted = hasRequiredAgreements(termsAcceptedAt, privacyAcceptedAt);
    const valid = isEmail(email) && isNickname(nickname) && isPassword(password) && isVerificationCode(code) && agreementsAccepted;

    const sendCode = async () => {
        setTouched(true);
        if (!isEmail(email)) { emailRef.current?.focus(); return; }
        setLoading(true); setMessage(''); setError(false);
        try { await sendVerification(email, 'signup'); setCodeSent(true); setMessage(t('auth.codeSent')); }
        catch { setError(true); setMessage(t('auth.serverError')); }
        finally { setLoading(false); }
    };

    const submit = async () => {
        setTouched(true);
        if (!valid) return;
        setLoading(true); setMessage(''); setError(false);
        try {
            if (termsAcceptedAt === null || privacyAcceptedAt === null) return;
            await registerUser({
                email,
                password,
                nickname,
                code,
                agreements: registrationAgreements(termsAcceptedAt, privacyAcceptedAt),
            });
            navigate('/login', { replace: true, state: { message: t('auth.signupSuccess') } });
        } catch (requestError) {
            setError(true);
            setMessage(requestError instanceof ApiError && requestError.status === 409
                ? t('auth.duplicateAccount')
                : requestError instanceof ApiError && requestError.status === 400
                    ? t('auth.invalidCodeServer')
                    : t('auth.serverError'));
        } finally { setLoading(false); }
    };

    return (
        <PageLayout title={t('auth.signup')} home settingsDock={false}>
            <RoundBox x={960} y={550} width={1360} height={870} type={2}/>
            <div className="signup-grid">
                <InlineLink onClick={() => navigate('/login')} style={{ gridColumn: '1 / -1', justifySelf: 'center' }}>{t('auth.goLogin')}</InlineLink>
                <div className="form-row" style={{ gridColumn: '1 / -1' }}>
                    <TextField ref={emailRef} label={t('auth.email')} placeholder={t('auth.emailPlaceholder')} autoComplete="email" value={email} disabled={codeSent} error={touched && !isEmail(email) ? t('auth.invalidEmail') : undefined} onChange={setEmail}/>
                    <RoundButton width={240} height={82} type={2} content={loading ? t('auth.sending') : t('auth.sendCode')} disabled={!isEmail(email) || codeSent} isLoading={loading} onClick={() => void sendCode()}/>
                </div>
                <TextField label={t('auth.nickname')} placeholder={t('auth.nicknamePlaceholder')} autoComplete="nickname" value={nickname} error={touched && !isNickname(nickname) ? t('auth.invalidNickname') : undefined} onChange={setNicknameValue}/>
                <TextField label={t('auth.code')} placeholder={t('auth.codePlaceholder')} inputMode="numeric" maxLength={6} value={code} disabled={!codeSent} error={touched && codeSent && !isVerificationCode(code) ? t('auth.invalidCode') : undefined} onChange={(value) => setCode(value.replace(/\D/g, ''))}/>
                <TextField label={t('auth.password')} placeholder={t('auth.passwordPlaceholder')} autoComplete="new-password" type="password" value={password} error={touched && !isPassword(password) ? t('auth.invalidPassword') : undefined} onChange={setPassword}/>
                <div className="signup-consents">
                    <div className="signup-consent-row">
                        <Checkbox
                            checked={termsAcceptedAt !== null}
                            label={t('auth.agreeTerms')}
                            onChange={(checked) => setTermsAcceptedAt(checked ? new Date().toISOString() : null)}
                        />
                        <button type="button" onClick={() => setOpenDocument(TERMS_OF_SERVICE)}>{t('auth.readDocument')}</button>
                    </div>
                    <div className="signup-consent-row">
                        <Checkbox
                            checked={privacyAcceptedAt !== null}
                            label={t('auth.agreePrivacy')}
                            onChange={(checked) => setPrivacyAcceptedAt(checked ? new Date().toISOString() : null)}
                        />
                        <button type="button" onClick={() => setOpenDocument(PRIVACY_POLICY)}>{t('auth.readDocument')}</button>
                    </div>
                </div>
                <div className={`status-message${error ? ' is-error' : ''}`} role="status" style={{ color: error ? themeColors(theme).text : themeColors(theme).muted }}>{message}</div>
                <RoundButton width={480} height={104} type={1} content={t('auth.signup')} disabled={!valid} isLoading={loading} onClick={() => void submit()} style={{ justifySelf: 'center' }}/>
            </div>
            {openDocument && <LegalDocumentDialog document={openDocument} onClose={() => setOpenDocument(null)}/>}
        </PageLayout>
    );
};
