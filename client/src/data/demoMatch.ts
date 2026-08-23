import type { LobbySnapshot, MatchResultSnapshot } from '../api/matches.ts';

export const DEMO_LOBBY: LobbySnapshot = {
    roomId: 'A42B3C',
    roomName: '느긋하게 한 판',
    map: 'forest',
    isPrivate: true,
    isLocked: false,
    minPlayers: 3,
    capacity: 8,
    startLockMs: 0,
    players: [
        { playerId: 'p1', slot: 1, colorIndex: 0, nickname: 'Seolmango', isHost: true, isSelf: true, guest: false, role: 'player', control: 'keyboard', skill: 'dash', stats: { games: 128, wins: 37, switchSuccessRate: 74 } },
        { playerId: 'p2', slot: 2, colorIndex: 1, nickname: 'Alice', isHost: false, isSelf: false, guest: false, role: 'player', control: 'touch', skill: 'flash', stats: { games: 84, wins: 19, switchSuccessRate: 61 } },
        { playerId: 'p3', slot: 3, colorIndex: 2, nickname: 'Bob', isHost: false, isSelf: false, guest: false, role: 'player', control: 'keyboard', skill: 'exhaust', stats: { games: 51, wins: 11, switchSuccessRate: 58 } },
        { playerId: 'p4', slot: 4, colorIndex: 3, nickname: 'Charlie', isHost: false, isSelf: false, guest: false, role: 'player', control: 'gamepad', skill: 'dash', stats: { games: 202, wins: 68, switchSuccessRate: 82 } },
        { playerId: 'p5', slot: 5, colorIndex: 4, nickname: '하늘고래', isHost: false, isSelf: false, guest: false, role: 'player', control: 'touch', skill: 'flash', stats: { games: 39, wins: 8, switchSuccessRate: 49 } },
        { playerId: 'g:demo', slot: 6, colorIndex: 5, nickname: 'Guest_7KPW2M', isHost: false, isSelf: false, guest: true, role: 'player', control: 'keyboard', skill: 'exhaust' },
    ],
};

export const DEMO_RESULT: MatchResultSnapshot = {
    matchId: 'demo-001',
    roomId: 'A42B3C',
    map: 'forest',
    durationMs: 264_000,
    playedAt: '2026-08-23T08:15:00.000Z',
    winners: ['p4', 'p1'],
    players: [
        { playerId: 'p4', slot: 4, nickname: 'Charlie', tagCount: 4, taggedCount: 1, switchSuccess: 7, switchTry: 9, survivedMs: 264_000, isSelf: false },
        { playerId: 'p1', slot: 1, nickname: 'Seolmango', tagCount: 3, taggedCount: 2, switchSuccess: 6, switchTry: 8, survivedMs: 252_000, isSelf: true },
        { playerId: 'p5', slot: 5, nickname: '하늘고래', tagCount: 2, taggedCount: 2, switchSuccess: 5, switchTry: 8, survivedMs: 221_000, isSelf: false },
        { playerId: 'p2', slot: 2, nickname: 'Alice', tagCount: 2, taggedCount: 3, switchSuccess: 3, switchTry: 7, survivedMs: 193_000, isSelf: false },
        { playerId: 'p6', slot: 6, nickname: 'Night Switch', tagCount: 1, taggedCount: 4, switchSuccess: 2, switchTry: 6, survivedMs: 158_000, isSelf: false },
        { playerId: 'p3', slot: 3, nickname: 'Bob', tagCount: 0, taggedCount: 4, switchSuccess: 2, switchTry: 5, survivedMs: 116_000, isSelf: false },
    ],
};
