import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ViolationSignal } from 'shared';
import { AbuseRateLimiter } from './rate-limit';
import { RateLimitViolationAggregator } from './rate-limit-violations';

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

it('does not combine per-connection traffic from clients sharing an IP', () => {
    const limiter = new AbuseRateLimiter(() => 100);
    const policy = { scopes: ['connection', 'user'] as const };
    for (let packet = 0; packet < 30; packet += 1) {
        for (let connectionId = 1; connectionId <= 3; connectionId += 1) {
            const decision = limiter.check('input', { connectionId, ip: '1.2.3.4', userId: connectionId }, 90, 1_000, policy);
            assert.equal(decision.allowed, true);
        }
    }
});

it('limits only the flooding connection when users share an IP', () => {
    const limiter = new AbuseRateLimiter(() => 100);
    const policy = { scopes: ['connection', 'user'] as const };
    for (let packet = 0; packet < 91; packet += 1) {
        limiter.check('input', { connectionId: 1, ip: '1.2.3.4', userId: 1 }, 90, 1_000, policy);
    }
    assert.equal(limiter.check('input', { connectionId: 1, ip: '1.2.3.4', userId: 1 }, 90, 1_000, policy).allowed, false);
    assert.equal(limiter.check('input', { connectionId: 2, ip: '1.2.3.4', userId: 2 }, 90, 1_000, policy).allowed, true);
});

it('does not classify ordinary persistent excess as socket-closing abuse', () => {
    let now = 0;
    const limiter = new AbuseRateLimiter(() => now);
    const subject = { connectionId: 1, ip: '1.2.3.4', userId: 1 };
    for (let window = 0; window < 5; window += 1) {
        let decision = limiter.check('input', subject, 10, 1_000, { scopes: ['connection', 'user'] });
        for (let packet = 1; packet < 12; packet += 1) decision = limiter.check('input', subject, 10, 1_000, { scopes: ['connection', 'user'] });
        assert.equal(decision.allowed, false);
        assert.equal(decision.abusive, false);
        now += 1_000;
    }
});

it('classifies more than five times the limit for five windows as abuse', () => {
    let now = 0;
    const limiter = new AbuseRateLimiter(() => now);
    const subject = { connectionId: 1, ip: '1.2.3.4', userId: 1 };
    let decision = limiter.check('json', subject, 2, 1_000, { scopes: ['connection', 'user'] });
    for (let window = 0; window < 5; window += 1) {
        for (let packet = window === 0 ? 1 : 0; packet < 11; packet += 1) {
            decision = limiter.check('json', subject, 2, 1_000, { scopes: ['connection', 'user'] });
        }
        assert.equal(decision.abusive, window === 4);
        now += 1_000;
    }
});

describe('rate-limit violation aggregation', () => {
    it('emits one summary with subject, rule, count, and duration', () => {
        let now = 100;
        const signals: ViolationSignal[] = [];
        const aggregator = new RateLimitViolationAggregator((signal) => signals.push(signal), () => now);
        const signal = { kind: 'RATE_LIMIT', userId: 7, roomId: 'room', tick: 1, severity: 'medium', ruleVersion: 1 } as const;
        aggregator.record(3, '1.2.3.4', 'input', signal);
        now = 350;
        aggregator.record(3, '1.2.3.4', 'input', { ...signal, severity: 'high' });
        aggregator.flushConnection(3);
        assert.equal(signals.length, 1);
        assert.equal(signals[0]?.severity, 'high');
        assert.deepEqual(signals[0]?.detail, {
            ip: '1.2.3.4', subject: 'connection:3', rule: 'input', count: 2, durationMs: 250,
        });
    });
});
