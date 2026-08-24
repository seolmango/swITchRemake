import { SkillRejection, SkillSlot } from 'shared';
import { describe, expect, it } from 'vitest';
import { getSwitchTargets, skillRejectionMessageKey, toCooldownDisplay } from './skillHud.ts';

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
