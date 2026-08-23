import assert from 'node:assert/strict';
import { it } from 'node:test';
import { AbuseRateLimiter } from './rate-limit';

it('keeps user/IP abuse streaks across connection replacement', () => {
    let now = 0;
    const limiter = new AbuseRateLimiter(() => now);
    for (let window = 0; window < 3; window += 1) {
        const subject = { connectionId: window + 1, ip: '1.2.3.4', userId: 7 };
        assert.equal(limiter.check('input', subject, 1, 1_000).allowed, true);
        const exceeded = limiter.check('input', subject, 1, 1_000);
        assert.equal(exceeded.allowed, false);
        assert.equal(exceeded.persistent, window === 2);
        now += 1_000;
    }
});
