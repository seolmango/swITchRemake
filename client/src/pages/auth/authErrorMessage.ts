import { ApiError } from '../../api/http.ts';

type Translate = (key: string) => string;

/** Maps account identity-switch errors before falling back to the generic authentication failure. */
export function loginErrorMessage(error: unknown, t: Translate): string {
    if (error instanceof ApiError && error.status === 401) return t('auth.invalidCredentials');
    if (error instanceof ApiError && error.status === 409 && error.code === 'IDENTITY_SWITCH_DURING_ROOM') {
        return t('auth.identitySwitchDuringRoom');
    }
    return t('auth.serverError');
}
