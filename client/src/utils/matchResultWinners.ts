import type { MatchPlayerResult, MatchResultSnapshot } from '../api/matches.ts';

export const matchResultWinners = (
    result: Pick<MatchResultSnapshot, 'players' | 'winners'>,
): MatchPlayerResult[] => {
    const playersById = new Map(result.players.map((player) => [player.playerId, player]));
    return [...new Set(result.winners)]
        .filter((winnerId) => winnerId !== '0')
        .map((winnerId) => playersById.get(winnerId))
        .filter((player): player is MatchPlayerResult => player !== undefined);
};
