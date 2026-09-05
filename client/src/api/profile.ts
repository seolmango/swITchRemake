import { apiRequest } from './http.ts';

export interface UserStats {
    level: number;
    xp: number;
    /** 이번 레벨에서 모은 XP와 다음 레벨까지 필요한 총량. 레벨 옆 진행도에 쓴다. */
    xpIntoLevel: number;
    xpForNextLevel: number;
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

/** 탈퇴 인증 코드. 지금 로그인한 계정의 주소로 서버가 보낸다 — 화면은 주소를 몰라도 된다. */
export const sendDeleteCode = () =>
    apiRequest<{ sent: true }>('/users/me/delete-code', { method: 'POST' });

export const deleteMyAccount = (code: string, secondFactorCode?: string) =>
    apiRequest<{ deleted: true }>('/users/me', {
        method: 'DELETE',
        body: { code, ...(secondFactorCode ? { secondFactorCode } : {}) },
    });

export const getMyStats = () => apiRequest<UserStats>('/users/me/stats', { method: 'GET' });

export const getMyMatches = (options: { limit?: number; cursor?: string } = {}) => {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor) query.set('cursor', options.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return apiRequest<UserMatchHistoryPage>(`/users/me/matches${suffix}`, { method: 'GET' });
};

/**
 * 리플레이를 받아 갈 한 번짜리 표를 끊는다.
 *
 * 파일은 인게임 서버 디스크에 있어서 매칭 서버를 통과하지 않는다. 여기서 받는 것은 주소뿐이고,
 * 보관 기간이 지난 경기에는 404가 온다.
 */
export const createReplayTicket = (matchId: string) =>
    apiRequest<{ path: string; expiresInMs: number }>(`/users/me/matches/${matchId}/replay-ticket`, { method: 'POST' });
