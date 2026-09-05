/**
 * `client/src/utils`의 순수 함수 검증.
 *
 * 함수 하나마다 파일을 하나씩 두었더니 한 번에 열어야 할 파일만 늘고 정작 무엇을 보장하는지는
 * 흩어졌다. 여기 있는 것은 전부 입력과 출력만 있는 함수라 한 파일에 모아도 서로를 방해하지 않는다.
 */
import { SkillRejection, SkillSlot } from 'shared';
import { describe, expect, it } from 'vitest';
import type { MatchPlayerResult, MatchResultSnapshot } from '../api/matches.ts';
import { formatKeyBinding, formatKeyBindings } from './keyBinding.ts';
import { isValidMatchId } from './matchId.ts';
import { matchResultWinners } from './matchResultWinners.ts';
import { getSwitchTargets, skillRejectionMessageKey, toCooldownDisplay } from './skillHud.ts';
import { switchTargetPlayerId } from './switchTarget.ts';
import { isRoomPassword } from './validation.ts';

describe('room password validation', () => {
    it('accepts only 4–8 digits at the boundaries', () => {
        expect(isRoomPassword('123')).toBe(false);
        expect(isRoomPassword('1234')).toBe(true);
        expect(isRoomPassword('12345678')).toBe(true);
        expect(isRoomPassword('123456789')).toBe(false);
        expect(isRoomPassword('12a4')).toBe(false);
    });
});

describe('switch target key mapping', () => {
    it.each([1, 2, 3, 4, 5, 6, 7, 8])('switch%d targets playerId %d', (number) => {
        expect(switchTargetPlayerId(`switch${number}` as const)).toBe(number);
    });
});

describe('match id validation', () => {
    it('accepts persisted UUID match ids', () => {
        expect(isValidMatchId('11111111-1111-4111-8111-111111111111')).toBe(true);
    });

    it('rejects missing and malformed route ids', () => {
        expect(isValidMatchId(undefined)).toBe(false);
        expect(isValidMatchId('undefined')).toBe(false);
        expect(isValidMatchId('../rooms')).toBe(false);
    });
});

describe('key binding labels', () => {
    it('formats persisted keyboard codes and modifiers', () => {
        expect(formatKeyBinding('KeyW', 'Unassigned')).toBe('W');
        expect(formatKeyBinding('Digit1', 'Unassigned')).toBe('1');
        expect(formatKeyBinding('ArrowUp', 'Unassigned')).toBe('↑');
        expect(formatKeyBinding('Shift+Digit1', 'Unassigned')).toBe('Shift+1');
        expect(formatKeyBinding(null, 'Unassigned')).toBe('Unassigned');
    });

    it('joins both binding slots for HUD labels', () => {
        expect(formatKeyBindings(['KeyW', 'ArrowUp'], 'Unassigned')).toBe('W / ↑');
        expect(formatKeyBindings([null, null], 'Unassigned')).toBe('Unassigned');
    });
});

describe('matchResultWinners', () => {
    const players: MatchPlayerResult[] = Array.from({ length: 8 }, (_, index) => ({
        playerId: String(index + 1),
        isGuest: false,
        slot: index + 1,
        nickname: `player${index + 1}`,
        tagCount: 0,
        taggedCount: 0,
        switchSuccess: 0,
        switchTry: 0,
        survivedMs: 1,
        isSelf: false,
    }));
    const winners = (value: MatchResultSnapshot['winners']) => matchResultWinners({ players, winners: value });

    it('removes empty winner placeholders', () => {
        expect(winners(['0', '0'])).toEqual([]);
    });

    it('collapses a duplicated winner id', () => {
        expect(winners(['1', '1']).map((player) => player.playerId)).toEqual(['1']);
    });

    it('keeps two distinct co-winners', () => {
        expect(winners(['1', '2']).map((player) => player.playerId)).toEqual(['1', '2']);
    });

    it('keeps every winner when the maximum-time result has eight survivors', () => {
        expect(winners(['1', '2', '3', '4', '5', '6', '7', '8']).map((player) => player.playerId))
            .toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    });
});

describe('switch target presentation', () => {
    const players = [
        { id: 0, alive: true, isTagger: false },
        { id: 1, alive: true, isTagger: true },
        { id: 2, alive: false, isTagger: false },
        { id: 3, alive: true, isTagger: false },
    ];

    it('omits the self player, tagger, and eliminated players', () => {
        expect(getSwitchTargets(players, 0)).toEqual([3]);
    });

    it('has no targets when the viewer is the tagger', () => {
        expect(getSwitchTargets(players, 1)).toEqual([]);
    });
});

describe('server cooldown presentation', () => {
    it('distinguishes an unavailable slot from an available zero cooldown', () => {
        expect(toCooldownDisplay([{ slot: SkillSlot.Movement, remainingMs: 0 }], SkillSlot.Switch, 5_000)).toMatchObject({ available: false, remainingMs: 0 });
        expect(toCooldownDisplay([{ slot: SkillSlot.Switch, remainingMs: 0 }], SkillSlot.Switch, 5_000)).toMatchObject({ available: true, remainingMs: 0, ratio: 0 });
    });

    it('calculates the sweep ratio from the server total', () => {
        expect(toCooldownDisplay([{ slot: SkillSlot.Movement, remainingMs: 1_250 }], SkillSlot.Movement, 5_000)).toMatchObject({
            available: false, remainingMs: 1_250, totalMs: 5_000, ratio: 0.25,
        });
    });
});

describe('skill rejection localization', () => {
    it('maps known values and safely falls back for unknown values', () => {
        expect(skillRejectionMessageKey(SkillRejection.OutOfRange)).toBe('game.skillRejected.outOfRange');
        expect(() => skillRejectionMessageKey('FUTURE_REASON')).not.toThrow();
        expect(skillRejectionMessageKey('FUTURE_REASON')).toBe('game.skillRejected.generic');
    });
});
