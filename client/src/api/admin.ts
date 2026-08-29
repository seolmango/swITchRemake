import { apiRequest } from './http.ts';

/** server-match/src/admin/admin.types.ts와 정확히 같아야 한다. */
export interface AdminGameServerView {
    serverId: string;
    buildVersion: string;
    protocolVersion: number;
    rulesVersion: string;
    internalAddress: string;
    waitingRooms: number;
    playingRooms: number;
    maxRooms: number;
    connections: number;
    loopLagMs: number;
    draining: boolean;
    updatedAt: number;
    stale: boolean;
}

export interface AdminMatchServerView {
    instanceId: string;
    buildVersion: string;
    protocolVersion: number;
    requestsPerMinute: number;
    pendingCommands: number;
    updatedAt: number;
    stale: boolean;
}

export interface AdminOverview {
    generatedAt: string;
    protocolVersion: number;
    gameServers: AdminGameServerView[];
    matchServers: AdminMatchServerView[];
    rooms: { waiting: number; playing: number; total: number; capacity: number };
    players: { inGame: number };
    users: { total: number; active: number; banned: number; deleted: number; newLastDay: number; activeSessions: number };
    matches: { open: number; lastHour: number; lastDay: number };
    registryDegraded: boolean;
}

/** 관리자 메뉴를 보일지 정하는 데만 쓴다. 실제 통제는 서버가 매 요청마다 다시 한다. */
export const getAdminAccess = () => apiRequest<{ admin: boolean }>('/admin/me', { method: 'GET' });

export const getAdminOverview = () => apiRequest<AdminOverview>('/admin/overview', { method: 'GET' });
