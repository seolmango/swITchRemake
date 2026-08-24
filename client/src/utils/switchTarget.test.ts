import { describe, expect, it } from 'vitest';
import { switchTargetPlayerId } from './switchTarget.ts';

describe('switch target key mapping', () => {
    it.each([1, 2, 3, 4, 5, 6, 7, 8])('switch%d targets playerId %d', (number) => {
        expect(switchTargetPlayerId(`switch${number}` as const)).toBe(number);
    });
});
