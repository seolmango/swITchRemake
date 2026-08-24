export interface ApiErrorBody {
    statusCode?: number;
    message?: string | string[];
    error?: string;
    code?: string;
    retryAfterMs?: number;
}

export class ApiError extends Error {
    readonly status: number;
    readonly details: string[];
    readonly code: string | null;
    readonly retryAfterMs: number | null;

    constructor(status: number, body: ApiErrorBody | null) {
        const details = Array.isArray(body?.message) ? body.message : body?.message ? [body.message] : [];
        super(details[0] ?? body?.error ?? `HTTP ${status}`);
        this.name = 'ApiError';
        this.status = status;
        this.details = details;
        this.code = typeof body?.code === 'string' ? body.code : null;
        this.retryAfterMs = typeof body?.retryAfterMs === 'number' && Number.isFinite(body.retryAfterMs)
            ? Math.max(0, body.retryAfterMs)
            : null;
    }
}

export type ApiIdentityKind = 'anonymous' | 'guest' | 'account';
export interface ApiIdentity {
    accessToken: string | null;
    kind: ApiIdentityKind;
    nickname: string | null;
}

interface GuestTokenResponse {
    accessToken: string;
    refreshToken: string;
    guest: { id: string; nickname: string };
    expiresIn: number;
    refreshExpiresIn: number;
}

const GUEST_REFRESH_KEY = 'switch-guest-refresh';
const ACTIVE_ROOM_KEY = 'switch-active-room';
const configuredBase = (import.meta.env.VITE_MATCH_API_URL as string | undefined)?.trim();
const API_BASE = configuredBase ? configuredBase.replace(/\/$/, '') : '/api';

let identity: ApiIdentity = { accessToken: null, kind: 'anonymous', nickname: null };
let identityListener: ((next: ApiIdentity) => void) | null = null;
let refreshFlight: Promise<string> | null = null;

export const setApiIdentity = (next: ApiIdentity) => {
    identity = next;
    identityListener?.(next);
};

export const setApiAccessToken = (token: string | null, nickname?: string) => {
    setApiIdentity({ accessToken: token, kind: token ? 'account' : 'anonymous', nickname: nickname ?? null });
};

export const setApiAccessTokenListener = (listener: (next: ApiIdentity) => void) => {
    identityListener = listener;
};

interface RequestOptions extends Omit<RequestInit, 'body'> {
    body?: unknown;
    auth?: boolean;
    retryAuth?: boolean;
}

const parseBody = async (response: Response): Promise<unknown> => {
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return { message: text }; }
};

const rawRequest = async <T>(path: string, options: RequestOptions): Promise<T> => {
    const headers = new Headers(options.headers);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (options.auth !== false && identity.accessToken) headers.set('Authorization', `Bearer ${identity.accessToken}`);
    const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: 'include',
        headers,
    });
    const body = await parseBody(response);
    if (!response.ok) throw new ApiError(response.status, body as ApiErrorBody | null);
    return body as T;
};

const acceptGuest = (result: GuestTokenResponse): string => {
    sessionStorage.setItem(GUEST_REFRESH_KEY, result.refreshToken);
    setApiIdentity({ accessToken: result.accessToken, kind: 'guest', nickname: result.guest.nickname });
    return result.accessToken;
};

const issueGuest = async (): Promise<string> => acceptGuest(await rawRequest<GuestTokenResponse>('/auth/guest', {
    method: 'POST', auth: false, retryAuth: false,
}));

const refreshGuest = async (): Promise<string> => {
    const refreshToken = sessionStorage.getItem(GUEST_REFRESH_KEY);
    if (!refreshToken) throw new ApiError(401, { message: 'No guest refresh token' });
    return acceptGuest(await rawRequest<GuestTokenResponse>('/auth/guest/refresh', {
        method: 'POST', auth: false, retryAuth: false, body: { refreshToken },
    }));
};

const refreshAccount = async (): Promise<string> => {
    const result = await rawRequest<{ accessToken: string; nickname: string }>('/auth/refresh', {
        method: 'POST', auth: false, retryAuth: false,
    });
    setApiIdentity({ accessToken: result.accessToken, kind: 'account', nickname: result.nickname });
    return result.accessToken;
};

const refreshCurrentIdentity = (): Promise<string> => {
    if (!refreshFlight) {
        refreshFlight = (identity.kind === 'guest' ? refreshGuest() : refreshAccount())
            .finally(() => { refreshFlight = null; });
    }
    return refreshFlight;
};

export const apiRequest = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
    try {
        return await rawRequest<T>(path, options);
    } catch (error) {
        const canRefresh = options.auth !== false
            && options.retryAuth !== false
            && identity.kind !== 'anonymous'
            && error instanceof ApiError
            && error.status === 401;
        if (!canRefresh) throw error;
        try {
            await refreshCurrentIdentity();
            return await rawRequest<T>(path, { ...options, retryAuth: false });
        } catch (refreshError) {
            if (identity.kind === 'guest') sessionStorage.removeItem(GUEST_REFRESH_KEY);
            setApiIdentity({ accessToken: null, kind: 'anonymous', nickname: null });
            throw refreshError;
        }
    }
};

export const bootstrapApiIdentity = async (): Promise<ApiIdentity> => {
    if (sessionStorage.getItem(GUEST_REFRESH_KEY)) {
        try { await refreshGuest(); return identity; } catch {
            if (sessionStorage.getItem(ACTIVE_ROOM_KEY)) {
                throw new ApiError(401, { message: 'Guest session expired during an active room' });
            }
            sessionStorage.removeItem(GUEST_REFRESH_KEY);
        }
    }
    try { await refreshAccount(); return identity; } catch { /* no active account cookie */ }
    await issueGuest();
    return identity;
};

export const replaceGuestWithAccount = (accessToken: string, nickname: string) => {
    sessionStorage.removeItem(GUEST_REFRESH_KEY);
    setApiIdentity({ accessToken, kind: 'account', nickname });
};

export const logoutAndCreateGuest = async (): Promise<ApiIdentity> => {
    if (identity.kind !== 'anonymous') {
        try {
            await rawRequest('/auth/logout', { method: 'POST', retryAuth: false });
        } catch (error) {
            if (error instanceof ApiError && error.status === 409) throw error;
            // A network failure must not resurrect an account from a refresh cookie in this tab.
        }
    }
    sessionStorage.removeItem(GUEST_REFRESH_KEY);
    setApiIdentity({ accessToken: null, kind: 'anonymous', nickname: null });
    await issueGuest();
    return identity;
};

export const tryRefreshSession = async (): Promise<string | null> => {
    try { return await refreshAccount(); } catch { return null; }
};
