import { describe, expect, it } from 'vitest';
import type { MatchPlayerResult, MatchResultSnapshot } from '../api/matches.ts';
import { matchResultWinners } from './matchResultWinners.ts';

const players: MatchPlayerResult[] = [
    { playerId: '1', slot: 1, nickname: 'one', tagCount: 0, taggedCount: 0, switchSuccess: 0, switchTry: 0, survivedMs: 1, isSelf: false },
    { playerId: '2', slot: 2, nickname: 'two', tagCount: 0, taggedCount: 0, switchSuccess: 0, switchTry: 0, survivedMs: 1, isSelf: false },
];

const winners = (value: MatchResultSnapshot['winners']) => matchResultWinners({ players, winners: value });

describe('matchResultWinners', () => {
    it('removes empty winner placeholders', () => {
        expect(winners(['0', '0'])).toEqual([]);
    });

    it('collapses a duplicated winner id', () => {
        expect(winners(['1', '1']).map((player) => player.playerId)).toEqual(['1']);
    });

    it('keeps two distinct co-winners', () => {
        expect(winners(['1', '2']).map((player) => player.playerId)).toEqual(['1', '2']);
    });
});
