'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AuditBots } = require('./audit-bots.cjs');

test('normal start retries wait after a quick lock response', { timeout: 4_000 }, async () => {
    // Only the command scheduler is exercised: no constructor, credentials,
    // transport, Redis, Docker, or external connection is involved.
    const fixture = Object.create(AuditBots.prototype);
    fixture.deadline = Date.now() + 3_000;
    fixture.closing = false;
    fixture.bots = [{ events: [] }];
    const sentAt = [];
    fixture.command = () => {
        sentAt.push(Date.now());
        const requestId = sentAt.length;
        fixture.bots[0].events.push(requestId === 1
            ? { type: 'error', payload: { requestId, code: 'START_LOCKED' } }
            : { type: 'game.started' });
        return requestId;
    };
    assert.equal((await fixture.start(0)).type, 'game.started');
    assert.equal(sentAt.length, 2);
    assert.ok(sentAt[1] - sentAt[0] >= 900, 'respect a bounded retry delay and the real JSON rate limit');
    assert.ok(sentAt.every(start => sentAt.filter(at => at >= start && at < start + 1_000).length <= 2));
});

test('locked start terminates within its duration budget without a retry burst', { timeout: 3_000 }, async () => {
    const fixture = Object.create(AuditBots.prototype);
    fixture.deadline = Date.now() + 1_050;
    fixture.closing = false;
    fixture.bots = [{ events: [] }];
    const sentAt = [];
    fixture.command = () => {
        sentAt.push(Date.now());
        const requestId = sentAt.length;
        fixture.bots[0].events.push({ type: 'error', payload: { requestId, code: 'START_LOCKED' } });
        return requestId;
    };
    const before = Date.now();
    await assert.rejects(() => fixture.start(0), /duration budget exhausted/);
    const elapsed = Date.now() - before;
    assert.ok(elapsed >= 900 && elapsed < 2_000, 'lock retry waits and then terminates within its bounded budget');
    assert.equal(sentAt.length, 1, 'never issue a retry when one second no longer remains');
});
