export interface ApiErrorBody {
    statusCode?: number;
    message?: string | string[];
    error?: string;
}

export class ApiError extends Error {
    readonly status: number;
    readonly details: string[];

    constructor(status: number, body: ApiErrorBody | null) {
        const details = Array.isArray(body?.message) ? body.message : body?.message ? [body.message] : [];
        super(details[0] ?? body?.error ?? `HTTP ${status}`);
        this.name = 'ApiError';
        this.status = status;
        this.details = details;
    }
}

const configuredBase = (import.meta.env.VITE_MATCH_API_URL as string | undefined)?.trim();
const API_BASE = configuredBase ? configuredBase.replace(/\/$/, '') : '/api';

let accessToken: string | null = null;
let tokenListener: ((token: string | null, nickname?: string) => void) | null = null;

export const setApiAccessToken = (token: string | null, nickname?: string) => {
    accessToken = token;
    tokenListener?.(token, nickname);
};

export const setApiAccessTokenListener = (listener: (token: string | null, nickname?: string) => void) => {
    tokenListener = listener;
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
    if (options.auth !== false && accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

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

const refreshAccessToken = async (): Promise<string> => {
    const result = await rawRequest<{ accessToken: string; nickname: string }>('/auth/refresh', {
        method: 'POST',
        auth: false,
        retryAuth: false,
    });
    setApiAccessToken(result.accessToken, result.nickname);
    return result.accessToken;
};

export const apiRequest = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
    try {
        return await rawRequest<T>(path, options);
    } catch (error) {
        const canRefresh = options.auth !== false && options.retryAuth !== false && accessToken && error instanceof ApiError && error.status === 401;
        if (!canRefresh) throw error;
        try {
            await refreshAccessToken();
            return await rawRequest<T>(path, { ...options, retryAuth: false });
        } catch (refreshError) {
            setApiAccessToken(null);
            throw refreshError;
        }
    }
};

export const tryRefreshSession = async (): Promise<string | null> => {
    try { return await refreshAccessToken(); } catch { setApiAccessToken(null); return null; }
};
