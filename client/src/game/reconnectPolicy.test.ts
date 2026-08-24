import { describe, expect, it } from 'vitest';
import { reconnectDelayMs } from './reconnectPolicy.ts';

describe('game reconnect backoff', () => {
    it('grows exponentially and caps at two seconds', () => {
        expect([0, 1, 2, 3, 4].map((attempt) => reconnectDelayMs(attempt, 0)))
            .toEqual([250, 500, 1_000, 2_000, 2_000]);
    });

    it('does not retry outside the server grace budget', () => {
        expect(reconnectDelayMs(0, 8_900)).toBe(100);
        expect(reconnectDelayMs(0, 9_000)).toBeNull();
    });
});
