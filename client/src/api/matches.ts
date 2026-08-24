import { apiRequest } from './http.ts';
import type { PlayerRole, SkillId } from 'shared';

/** Local presentation-only room model used by the demo lobby and lobby cards. */
export type LobbyMap = string;
export type PlayerControl = 'keyboard' | 'touch' | 'gamepad';
export type PlayerSkill = Exclude<SkillId, 'switch'>;

export interface LobbyViewPlayerStats {
    games: number;
    wins: number;
    switchSuccessRate: number;
}

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
    stats?: LobbyViewPlayerStats;
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

export const matchApiEnabled = import.meta.env.VITE_ENABLE_MATCH_API === 'true';

export const getMatchResult = (matchId: string) =>
    apiRequest<MatchResultSnapshot>(`/matches/${encodeURIComponent(matchId)}/result`, { method: 'GET' });
