import { describe, expect, it } from 'vitest';
import { isValidMatchId } from './matchId.ts';

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
