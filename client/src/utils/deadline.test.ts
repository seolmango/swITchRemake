import { describe, expect, it } from 'vitest';
import { deadlineAfterSeconds, secondsUntil } from './deadline.ts';

describe('MFA countdowns', () => {
    it('uses the server duration and reaches zero without becoming negative', () => {
        const deadline = deadlineAfterSeconds(300, 1_000);
        expect(secondsUntil(deadline, 1_000)).toBe(300);
        expect(secondsUntil(deadline, 300_001)).toBe(1);
        expect(secondsUntil(deadline, 301_000)).toBe(0);
        expect(secondsUntil(deadline, 999_999)).toBe(0);
    });

    it('keeps an absent retry deadline absent', () => {
        expect(secondsUntil(null, 1_000)).toBeNull();
    });
});
