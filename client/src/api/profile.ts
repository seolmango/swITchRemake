import { apiRequest } from './http.ts';

export interface UserStats {
    level: number;
    xp: number;
    games: number;
    wins: number;
    switchTry: number;
    switchSuccess: number;
    tagCount: number;
    deathOrder: number;
    winRate: number;
    switchSuccessRate: number;
}

export interface UserMatchHistoryItem {
    matchId: string;
    endedAt: string;
    map: string;
    won: boolean;
    tagCount: number;
    taggedCount: number;
    switchTry: number;
    switchSuccess: number;
    survivedMs: number;
}

export interface UserMatchHistoryPage {
    matches: UserMatchHistoryItem[];
    nextCursor: string | null;
}

export const getMyStats = () => apiRequest<UserStats>('/users/me/stats', { method: 'GET' });

export const getMyMatches = (options: { limit?: number; cursor?: string } = {}) => {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor) query.set('cursor', options.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return apiRequest<UserMatchHistoryPage>(`/users/me/matches${suffix}`, { method: 'GET' });
};
