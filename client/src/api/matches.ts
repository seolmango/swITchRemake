import { apiRequest } from './http.ts';
import type { LobbyStats, PlayerRole, SkillId } from 'shared';

/** Local presentation-only room model used by the demo lobby and lobby cards. */
export type LobbyMap = string;
export type PlayerControl = 'keyboard' | 'touch' | 'gamepad';
export type PlayerSkill = Exclude<SkillId, 'switch'>;

export interface LobbyViewPlayer {
    playerId: string;
    slot: number;
    colorIndex: number;
    nickname: string;
    isHost: boolean;
    isSelf: boolean;
    guest: boolean;
    role: PlayerRole;
    control: PlayerControl;
    skill: PlayerSkill;
    /** 게스트와 전적이 안 온 사람은 null이다. 계산은 매칭 서버가 한다. */
    stats: LobbyStats | null;
}

/**
 * View model composed from matching-server room metadata, the game server's
 * lobby.state event, and optional profile statistics.
 */
export interface LobbySnapshot {
    roomId: string;
    roomName: string;
    map: LobbyMap;
    isPrivate: boolean;
    isLocked: boolean;
    minPlayers: number;
    capacity: number;
    startLockMs: number;
    players: LobbyViewPlayer[];
}

/** Direct payload of game.ended; returnsAt controls the POST_GAME deadline. */
export interface GameEndedEventPayload {
    matchId: string;
    winnerIds: [number, number];
    returnsAt: number;
}

export interface MatchPlayerResult {
    playerId: string;
    slot: number;
    nickname: string;
    tagCount: number;
    taggedCount: number;
    switchSuccess: number;
    switchTry: number;
    survivedMs: number;
    isSelf: boolean;
}

export interface MatchResultSnapshot {
    matchId: string;
    roomId: string;
    map: LobbyMap;
    durationMs: number;
    playedAt: string;
    /** game.ended returnsAt; omitted for persisted match-history responses. */
    returnsAt?: number;
    /** The final two players. Both are co-winners and are stored without ordering. */
    winners: [string, string];
    players: MatchPlayerResult[];
}

export interface PendingMatchResult {
    status: 'pending';
    retryAfterMs: number;
}

export type MatchResultResponse = MatchResultSnapshot | PendingMatchResult;

export const getMatchResult = (matchId: string) =>
    apiRequest<MatchResultResponse>(`/matches/${encodeURIComponent(matchId)}/result`, { method: 'GET' });
