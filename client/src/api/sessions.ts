import { apiRequest } from './http.ts';

export interface LoginSession {
    id: string;
    deviceLabel: string;
    createdAt: string;
    lastUsedAt: string;
    expiresAt: string;
    current: boolean;
}

export const getLoginSessions = () =>
    apiRequest<{ sessions: LoginSession[] }>('/users/me/sessions', { method: 'GET' });

export const revokeLoginSession = (sessionId: string) =>
    apiRequest<{ revoked: true; current: boolean }>(`/users/me/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });

export const revokeOtherLoginSessions = () =>
    apiRequest<{ revokedCount: number }>('/users/me/sessions/others', { method: 'DELETE' });
