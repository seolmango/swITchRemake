import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IpRateLimiter } from './ip-rate-limit';

test('리플레이 공개 요청 예산을 IP별로 나누고 다음 창에서 되돌린다', () => {
    let now = 0;
    const limiter = new IpRateLimiter(() => now);
    assert.equal(limiter.allow('1.2.3.4', 2, 60_000), true);
    assert.equal(limiter.allow('1.2.3.4', 2, 60_000), true);
    assert.equal(limiter.allow('1.2.3.4', 2, 60_000), false);
    assert.equal(limiter.allow('5.6.7.8', 2, 60_000), true);
    now = 60_000;
    assert.equal(limiter.allow('1.2.3.4', 2, 60_000), true);
});

test('서로 다른 IP가 버킷 지도를 상한 이상 늘리지 못한다', () => {
    const limiter = new IpRateLimiter(() => 0, 1);
    assert.equal(limiter.allow('1.2.3.4', 2, 60_000), true);
    assert.equal(limiter.allow('5.6.7.8', 2, 60_000), false);
});
