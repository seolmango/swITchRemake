import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
    confirmTotpMfa,
    disableMfa,
    enableEmailMfa,
    getMfaStatus,
    getTrustedDevices,
    regenerateBackupCodes,
    revokeTrustedDevice,
    sendMfaEmailCode,
    setupTotpMfa,
    type MfaMethod,
    type MfaStatus,
    type TotpSetup,
    type TrustedDevice,
} from '../../api/mfa.ts';
import { useAuthStore } from '../../stores/useAuthStore.ts';
import { TextField } from '../common/TextField.tsx';
import { Checkbox } from '../common/Checkbox.tsx';
import { Icon } from '../common/Icon.tsx';
import { mfaErrorMessage, retryAfterSeconds } from '../../pages/auth/authErrorMessage.ts';
import { deadlineAfterSeconds, useDeadlineSeconds } from '../../utils/deadline.ts';
import { ApiError } from '../../api/http.ts';

type SecurityAction =
    | { kind: 'disable' }
    | { kind: 'regenerate' }
    | { kind: 'revoke'; device: TrustedDevice };

const copyText = async (value: string): Promise<void> => {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(value);
};

const saveBackupCodes = (codes: string[]): void => {
    const blob = new Blob([`${codes.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'swITch-backup-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
};

export const MfaSettings: React.FC = () => {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const authenticated = useAuthStore((state) => state.status === 'account');
    const [status, setStatus] = useState<MfaStatus | null>(null);
    const [devices, setDevices] = useState<TrustedDevice[]>([]);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [method, setMethod] = useState<MfaMethod>('email');
    const [currentPassword, setCurrentPassword] = useState('');
    const [setup, setSetup] = useState<(TotpSetup & { expiresAt: number }) | null>(null);
    const [setupCode, setSetupCode] = useState('');
    const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
    const [backupAcknowledged, setBackupAcknowledged] = useState(false);
    const [action, setAction] = useState<SecurityAction | null>(null);
    const [actionCode, setActionCode] = useState('');
    const [message, setMessage] = useState('');
    const [failed, setFailed] = useState(false);
    const [retryDeadline, setRetryDeadline] = useState<number | null>(null);
    const actionInputRef = useRef<HTMLInputElement>(null);
    const backupButtonRef = useRef<HTMLButtonElement>(null);
    const setupRemaining = useDeadlineSeconds(setup?.expiresAt ?? null);
    const retryRemaining = useDeadlineSeconds(retryDeadline);

    const handleError = useCallback((error: unknown) => {
        const retrySeconds = retryAfterSeconds(error);
        if (retrySeconds !== null) setRetryDeadline(deadlineAfterSeconds(retrySeconds));
        setFailed(true);
        setMessage(mfaErrorMessage(error, t));
    }, [t]);

    const loadSecurity = useCallback(async () => {
        if (!authenticated) return;
        setLoading(true);
        setFailed(false);
        setMessage('');
        try {
            const nextStatus = await getMfaStatus();
            setStatus(nextStatus);
            if (nextStatus.enabled) {
                try {
                    setDevices((await getTrustedDevices()).devices);
                } catch {
                    setDevices([]);
                    setMessage(t('settings.security.devicesLoadFailed'));
                    setFailed(true);
                }
            } else {
                setDevices([]);
            }
        } catch (error) {
            handleError(error);
        } finally {
            setLoading(false);
        }
    }, [authenticated, handleError, t]);

    useEffect(() => { void loadSecurity(); }, [loadSecurity]);

    useEffect(() => {
        if (!action) return;
        window.requestAnimationFrame(() => actionInputRef.current?.focus());
    }, [action]);

    useEffect(() => {
        if (!backupCodes) return;
        window.requestAnimationFrame(() => backupButtonRef.current?.focus());
    }, [backupCodes]);

    const beginEnable = async () => {
        if (!currentPassword || busy || (retryRemaining ?? 0) > 0) return;
        setBusy(true); setFailed(false); setMessage('');
        try {
            if (method === 'email') {
                const result = await enableEmailMfa(currentPassword);
                setStatus({ enabled: true, method: 'email', backupCodesRemaining: result.backupCodes.length });
                setBackupCodes(result.backupCodes);
                setBackupAcknowledged(false);
                setCurrentPassword('');
            } else {
                const result = await setupTotpMfa(currentPassword);
                setSetup({ ...result, expiresAt: deadlineAfterSeconds(result.expiresIn) });
                setSetupCode('');
                setCurrentPassword('');
                setMessage(t('settings.security.secretReady'));
            }
        } catch (error) {
            handleError(error);
        } finally { setBusy(false); }
    };

    const confirmSetup = async () => {
        if (!setup || !setupCode.trim() || setupRemaining === 0 || busy || (retryRemaining ?? 0) > 0) return;
        setBusy(true); setFailed(false); setMessage('');
        try {
            const result = await confirmTotpMfa(setup.setupToken, setupCode.trim());
            setSetup(null);
            setSetupCode('');
            setStatus({ enabled: true, method: 'totp', backupCodesRemaining: result.backupCodes.length });
            setBackupCodes(result.backupCodes);
            setBackupAcknowledged(false);
        } catch (error) {
            handleError(error);
            if (error instanceof ApiError && (error.code === 'INVALID_TOTP_SETUP' || error.code === 'TOTP_SETUP_RETRY')) {
                setSetup((current) => current ? { ...current, expiresAt: Date.now() } : current);
            }
        } finally { setBusy(false); }
    };

    const sendStepUpCode = async () => {
        if (busy || (retryRemaining ?? 0) > 0) return;
        setBusy(true); setFailed(false); setMessage('');
        try {
            await sendMfaEmailCode();
            setMessage(t('settings.security.emailCodeSent'));
        } catch (error) {
            handleError(error);
        } finally { setBusy(false); }
    };

    const beginAction = (next: SecurityAction) => {
        setAction(next);
        setActionCode('');
        setFailed(false);
        setMessage('');
    };

    const runAction = async () => {
        if (!action || !actionCode.trim() || busy || (retryRemaining ?? 0) > 0) return;
        setBusy(true); setFailed(false); setMessage('');
        try {
            if (action.kind === 'disable') {
                await disableMfa(actionCode.trim());
                setStatus({ enabled: false, method: null, backupCodesRemaining: 0 });
                setDevices([]);
                setMessage(t('settings.security.disabled'));
            } else if (action.kind === 'regenerate') {
                const result = await regenerateBackupCodes(actionCode.trim());
                setStatus((current) => current ? { ...current, backupCodesRemaining: result.backupCodesRemaining } : current);
                setBackupCodes(result.backupCodes);
                setBackupAcknowledged(false);
            } else {
                await revokeTrustedDevice(action.device.id, actionCode.trim());
                setDevices((current) => current.filter((device) => device.id !== action.device.id));
                setMessage(t('settings.security.deviceRevoked'));
            }
            setAction(null);
            setActionCode('');
        } catch (error) {
            handleError(error);
        } finally { setBusy(false); }
    };

    const copySetupSecret = async () => {
        if (!setup) return;
        try {
            await copyText(setup.secret);
            setFailed(false);
            setMessage(t('settings.security.secretCopied'));
        } catch {
            setFailed(true);
            setMessage(t('settings.security.copyFailed'));
        }
    };

    const copyBackupCodes = async () => {
        if (!backupCodes) return;
        try {
            await copyText(backupCodes.join('\n'));
            setFailed(false);
            setMessage(t('settings.security.codesCopied'));
        } catch {
            setFailed(true);
            setMessage(t('settings.security.copyFailed'));
        }
    };

    const formatDate = (value: string) => new Intl.DateTimeFormat(i18n.language, {
        dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(value));

    const shownMessage = (retryRemaining ?? 0) > 0
        ? t('auth.rateLimited', { seconds: retryRemaining })
        : message;

    if (!authenticated) {
        return (
            <div className="mfa-empty-card">
                <Icon name="person" size={50}/>
                <strong>{t('settings.security.loginRequired')}</strong>
                <button type="button" onClick={() => navigate('/login')}>{t('auth.login')}</button>
            </div>
        );
    }

    if (loading && !status) return <div className="mfa-loading" aria-busy="true">{t('settings.security.loading')}</div>;
    if (!status) {
        return (
            <div className="mfa-empty-card" role="alert">
                <strong>{shownMessage || t('settings.security.loadFailed')}</strong>
                <button type="button" disabled={(retryRemaining ?? 0) > 0} onClick={() => void loadSecurity()}>{t('common.retry')}</button>
            </div>
        );
    }

    if (backupCodes) {
        return (
            <section className="mfa-backup-dialog" role="dialog" aria-labelledby="backup-code-title">
                <span>{t('settings.security.oneTimeCodes')}</span>
                <h2 id="backup-code-title">{t('settings.security.saveBackupCodes')}</h2>
                <p>{t('settings.security.backupCodesOnlyOnce')}</p>
                <div className="mfa-backup-list" aria-label={t('settings.security.backupCodes')}>
                    {backupCodes.map((code) => <code key={code}>{code}</code>)}
                </div>
                <div className="mfa-backup-actions">
                    <button ref={backupButtonRef} type="button" onClick={() => void copyBackupCodes()}>{t('common.copy')}</button>
                    <button type="button" onClick={() => saveBackupCodes(backupCodes)}>{t('common.saveFile')}</button>
                </div>
                {shownMessage && <p className="mfa-message" role={failed ? 'alert' : 'status'} data-failed={failed ? 'true' : 'false'}>{shownMessage}</p>}
                <Checkbox checked={backupAcknowledged} onChange={setBackupAcknowledged} label={t('settings.security.codesSaved')}/>
                <button
                    type="button"
                    className="mfa-primary-button"
                    disabled={!backupAcknowledged}
                    onClick={() => { setBackupCodes(null); setBackupAcknowledged(false); setMessage(''); }}
                >
                    {t('common.done')}
                </button>
            </section>
        );
    }

    return (
        <div className="mfa-settings">
            <section className={`mfa-status-card ${status.enabled ? 'is-enabled' : ''}`}>
                <div>
                    <span>{t('settings.security.status')}</span>
                    <strong>{t(status.enabled ? 'settings.security.enabled' : 'settings.security.off')}</strong>
                </div>
                {status.enabled && <b>{t(`settings.security.method.${status.method}`)}</b>}
            </section>

            {!status.enabled && !setup ? (
                <section className="mfa-enable-panel">
                    <h3>{t('settings.security.chooseMethod')}</h3>
                    <div className="mfa-methods" role="radiogroup" aria-label={t('settings.security.chooseMethod')}>
                        {(['email', 'totp'] as const).map((choice) => (
                            <button
                                type="button"
                                role="radio"
                                aria-checked={method === choice}
                                className={method === choice ? 'is-active' : ''}
                                key={choice}
                                onClick={() => setMethod(choice)}
                            >
                                <strong>{t(`settings.security.method.${choice}`)}</strong>
                                <span>{t(`settings.security.method.${choice}Help`)}</span>
                            </button>
                        ))}
                    </div>
                    <div className="mfa-enable-fields">
                        <TextField
                            label={t('auth.currentPassword')}
                            placeholder={t('auth.passwordPlaceholder')}
                            type="password"
                            autoComplete="current-password"
                            value={currentPassword}
                            onChange={setCurrentPassword}
                        />
                        <button type="button" className="mfa-primary-button" disabled={!currentPassword || busy || (retryRemaining ?? 0) > 0} onClick={() => void beginEnable()}>
                            {t(method === 'email' ? 'settings.security.enable' : 'settings.security.setup')}
                        </button>
                    </div>
                </section>
            ) : status.enabled ? (
                <>
                    <section className="mfa-summary-grid">
                        <article>
                            <span>{t('settings.security.backupCodes')}</span>
                            <strong>{status.backupCodesRemaining}</strong>
                            <button type="button" onClick={() => beginAction({ kind: 'regenerate' })}>{t('settings.security.regenerate')}</button>
                        </article>
                        <article>
                            <span>{t('settings.security.turnOff')}</span>
                            <strong>{t(`settings.security.method.${status.method}`)}</strong>
                            <button type="button" className="is-danger" onClick={() => beginAction({ kind: 'disable' })}>{t('settings.security.disable')}</button>
                        </article>
                    </section>

                    <section className="mfa-device-panel">
                        <header>
                            <div>
                                <span>{t('settings.security.trustedDevices')}</span>
                                <h3>{t('settings.security.trustedDevicesTitle')}</h3>
                            </div>
                            <button type="button" onClick={() => void loadSecurity()} disabled={loading || (retryRemaining ?? 0) > 0} aria-label={t('rooms.refresh')}><Icon name="refresh" size={26}/></button>
                        </header>
                        <div className="mfa-device-list">
                            {devices.map((device) => (
                                <article key={device.id} className={device.current ? 'is-current' : ''}>
                                    <div>
                                        <strong>{device.deviceLabel}</strong>
                                        <span>{t('settings.security.lastUsed', { date: formatDate(device.lastUsedAt) })}</span>
                                        <small>{t('settings.security.expiresAt', { date: formatDate(device.expiresAt) })}</small>
                                    </div>
                                    {device.current && <b>{t('settings.security.currentDevice')}</b>}
                                    <button type="button" onClick={() => beginAction({ kind: 'revoke', device })}>{t('settings.security.revoke')}</button>
                                </article>
                            ))}
                            {devices.length === 0 && <p>{t('settings.security.noTrustedDevices')}</p>}
                        </div>
                    </section>
                </>
            ) : null}

            {setup && (
                <section className="mfa-secret-card" aria-labelledby="mfa-secret-title">
                    <span>{t('settings.security.oneTimeSecret')}</span>
                    <h3 id="mfa-secret-title">{t('settings.security.addToApp')}</h3>
                    <p>{t('settings.security.secretOnlyOnce')}</p>
                    <code>{setup.secret}</code>
                    <button type="button" onClick={() => void copySetupSecret()}>{t('common.copy')}</button>
                    <TextField
                        label={t('auth.secondFactorCode')}
                        placeholder={t('auth.sixDigitCode')}
                        autoFocus
                        autoComplete="one-time-code"
                        inputMode="numeric"
                        value={setupCode}
                        onChange={setSetupCode}
                    />
                    <div className="mfa-secret-actions">
                        <span>{setupRemaining === 0 ? t('auth.totpSetupExpired') : t('settings.security.setupExpiresIn', { seconds: setupRemaining ?? 0 })}</span>
                        {setupRemaining === 0 ? (
                            <button type="button" onClick={() => { setSetup(null); setSetupCode(''); setMessage(''); }}>{t('settings.security.restartSetup')}</button>
                        ) : (
                            <button type="button" className="mfa-primary-button" disabled={!setupCode.trim() || busy || (retryRemaining ?? 0) > 0} onClick={() => void confirmSetup()}>
                                {t('settings.security.confirm')}
                            </button>
                        )}
                    </div>
                </section>
            )}

            {action && (
                <section className="mfa-action-card" aria-labelledby="mfa-action-title">
                    <div>
                        <h3 id="mfa-action-title">{t(`settings.security.action.${action.kind}`)}</h3>
                        {action.kind === 'revoke' && <span>{action.device.deviceLabel}</span>}
                    </div>
                    {status.method === 'email' && (
                        <button type="button" onClick={() => void sendStepUpCode()} disabled={busy || (retryRemaining ?? 0) > 0}>
                            {t('settings.security.sendEmailCode')}
                        </button>
                    )}
                    <input
                        ref={actionInputRef}
                        type="text"
                        autoComplete="one-time-code"
                        placeholder={t('auth.secondFactorPlaceholder')}
                        aria-label={t('auth.secondFactorCode')}
                        value={actionCode}
                        onChange={(event) => setActionCode(event.target.value)}
                    />
                    <button type="button" onClick={() => setAction(null)}>{t('common.cancel')}</button>
                    <button type="button" className={action.kind === 'disable' ? 'is-danger' : 'mfa-primary-button'} disabled={!actionCode.trim() || busy || (retryRemaining ?? 0) > 0} onClick={() => void runAction()}>
                        {t('settings.security.confirm')}
                    </button>
                </section>
            )}

            <p className="mfa-message" role={failed ? 'alert' : 'status'} aria-live="polite" data-failed={failed ? 'true' : 'false'}>{shownMessage}</p>

        </div>
    );
};
