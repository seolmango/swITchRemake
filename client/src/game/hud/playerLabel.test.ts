import { describe, expect, it } from 'vitest';
import { playerLabel } from './playerLabel.ts';

describe('playerLabel', () => {
    it('shows the one-based playerId without an offset', () => {
        expect(playerLabel(1)).toBe('1');
        expect(playerLabel(8)).toBe('8');
    });
});
