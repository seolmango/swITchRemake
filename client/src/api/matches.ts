import { apiRequest } from './http.ts';

export type LobbyMap = 'random' | 'openField' | 'forest' | 'stadium' | 'house';
export type PlayerControl = 'keyboard' | 'touch' | 'gamepad';
export type PlayerSkill = 'dash' | 'flash' | 'exhaust';
export type LobbyRole = 'player' | 'waiting' | 'spectator';

export interface LobbyPlayerStats {
    games: number;
    wins: number;
    switchSuccessRate: number;
}

export interface LobbyPlayer {
    playerId: string;
    slot: number;
    colorIndex: number;
    nickname: string;
    isHost: boolean;
    isSelf: boolean;
    guest: boolean;
    role: LobbyRole;
    control: PlayerControl;
    skill: PlayerSkill;
    stats?: LobbyPlayerStats;
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
    players: LobbyPlayer[];
}

/** Commands sent through the authenticated game-server WebSocket. */
export type LobbyClientCommand =
    | { v: 1; type: 'lobby.setMap'; requestId: number; payload: { mapId: LobbyMap } }
    | { v: 1; type: 'lobby.kick'; requestId: number; payload: { playerId: number } }
    | { v: 1; type: 'lobby.passHost'; requestId: number; payload: { playerId: number } }
    | { v: 1; type: 'lobby.setSlot'; requestId: number; payload: { slot: number } }
    | { v: 1; type: 'lobby.setLocked'; requestId: number; payload: { locked: boolean } }
    | { v: 1; type: 'lobby.setLoadout'; requestId: number; payload: { skills: PlayerSkill[]; control: PlayerControl } }
    | { v: 1; type: 'lobby.start'; requestId: number; payload: Record<string, never> }
    | { v: 1; type: 'lobby.leave'; requestId: number; payload: Record<string, never> };

/** Direct payload of the game server's lobby.state event. */
export interface LobbyStateEventPayload {
    hostId: number;
    mapId: LobbyMap;
    capacity: number;
    startLockMs: number;
    players: Array<{
        playerId: number;
        slot: number;
        nickname: string;
        colorIndex: number;
        guest: boolean;
        role: LobbyRole;
        control: PlayerControl;
        skills: PlayerSkill[];
        stats: LobbyPlayerStats | null;
    }>;
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
