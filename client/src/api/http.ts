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
        // Response text belongs in diagnostics, never in user-facing Error.message. Reverse-proxy and
        // framework 404 bodies can otherwise leak raw HTML or "Cannot GET ..." into the UI.
        super(`HTTP ${status}`);
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
/**
 * 진행 중인 토큰 재발급. **종류별로 하나씩만** 돈다.
 *
 * refresh 토큰은 한 번 쓰면 회전하고, 서버는 이미 쓴 토큰이 다시 오면 재사용 공격으로 보고
 * **그 계정의 세션을 전부 끊는다**(auth.service의 `kind: 'reuse'`). 그래서 같은 쿠키로 두 번
 * 동시에 부르면 정상 사용자가 로그아웃된다.
 *
 * 예전에는 401 재시도 경로만 이 guard를 지났고 부팅(`bootstrapApiIdentity`)은 그냥 불렀다.
 * 화면을 새로 띄우는 순간 다른 요청이 401을 맞으면 둘이 같은 쿠키를 동시에 써서, 방에서
 * 나오거나 화면을 두 번 옮기는 것만으로 로그인이 풀렸다.
 */
const refreshFlights = new Map<'guest' | 'account', Promise<string>>();

const singleFlight = (kind: 'guest' | 'account', run: () => Promise<string>): Promise<string> => {
    const existing = refreshFlights.get(kind);
    if (existing) return existing;
    const flight = run().finally(() => { refreshFlights.delete(kind); });
    refreshFlights.set(kind, flight);
    return flight;
};

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
    try { return JSON.parse(text); } catch { return null; }
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

const refreshGuest = (): Promise<string> => singleFlight('guest', async () => {
    const refreshToken = sessionStorage.getItem(GUEST_REFRESH_KEY);
    if (!refreshToken) throw new ApiError(401, { message: 'No guest refresh token' });
    return acceptGuest(await rawRequest<GuestTokenResponse>('/auth/guest/refresh', {
        method: 'POST', auth: false, retryAuth: false, body: { refreshToken },
    }));
});

const refreshAccount = (): Promise<string> => singleFlight('account', async () => {
    const result = await rawRequest<{ accessToken: string; nickname: string }>('/auth/refresh', {
        method: 'POST', auth: false, retryAuth: false,
    });
    setApiIdentity({ accessToken: result.accessToken, kind: 'account', nickname: result.nickname });
    return result.accessToken;
});

const refreshCurrentIdentity = (): Promise<string> =>
    identity.kind === 'guest' ? refreshGuest() : refreshAccount();

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

/**
 * 계정이 **없어진 뒤** 남은 것을 정리한다(탈퇴).
 *
 * `/auth/logout`을 부르지 않는다 — 지울 세션이 이미 없고, 그 호출은 진행 중인 방이 있으면
 * 409로 거절한다. 탈퇴한 사람을 방 때문에 로그인 상태로 붙잡아 둘 수는 없다.
 */
export const abandonSessionAndCreateGuest = async (): Promise<ApiIdentity> => {
    sessionStorage.removeItem(GUEST_REFRESH_KEY);
    sessionStorage.removeItem(ACTIVE_ROOM_KEY);
    setApiIdentity({ accessToken: null, kind: 'anonymous', nickname: null });
    await issueGuest();
    return identity;
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
