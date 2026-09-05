import { ApiError } from '../../api/http.ts';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Maps account identity-switch errors before falling back to the generic authentication failure. */
export function loginErrorMessage(error: unknown, t: Translate): string {
    if (error instanceof ApiError && error.status === 401) return t('auth.invalidCredentials');
    if (error instanceof ApiError && error.status === 409 && error.code === 'IDENTITY_SWITCH_DURING_ROOM') {
        return t('auth.identitySwitchDuringRoom');
    }
    return t('auth.serverError');
}

export function retryAfterSeconds(error: unknown): number | null {
    if (!(error instanceof ApiError) || error.status !== 429 || error.retryAfterMs === null) return null;
    return Math.max(1, Math.ceil(error.retryAfterMs / 1_000));
}

export function mfaErrorMessage(error: unknown, t: Translate): string {
    const retrySeconds = retryAfterSeconds(error);
    if (retrySeconds !== null) return t('auth.retryNow');
    if (error instanceof ApiError) {
        if (error.code === 'INVALID_SECOND_FACTOR') return t('auth.invalidSecondFactor');
        if (error.code === 'INVALID_MFA_CHALLENGE') return t('auth.mfaChallengeExpired');
        if (error.code === 'INVALID_TOTP_SETUP' || error.code === 'TOTP_SETUP_RETRY') return t('auth.totpSetupExpired');
        if (error.code === 'CURRENT_PASSWORD_INCORRECT') return t('auth.currentPasswordIncorrect');
        if (error.code === 'MFA_ALREADY_ENABLED') return t('auth.mfaAlreadyEnabled');
        if (error.code === 'MFA_NOT_ENABLED') return t('auth.mfaNotEnabled');
        if (error.code === 'MFA_LOGIN_RETRY') return t('auth.mfaRetryLogin');
    }
    return t('auth.serverError');
}
