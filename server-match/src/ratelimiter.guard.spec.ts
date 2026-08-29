import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRateLimitPolicy, rateLimitRelaxed } from './ratelimiter.guard';

/** 이 플래그는 환경변수 하나로 한도를 50배로 벌린다. 실수로 운영에 딸려 가면 안 된다. */
function withFlag<T>(value: string | undefined, run: () => T): T {
    const previous = process.env.RATE_LIMIT_RELAXED;
    if (value === undefined) delete process.env.RATE_LIMIT_RELAXED;
    else process.env.RATE_LIMIT_RELAXED = value;
    try {
        return run();
    } finally {
        if (previous === undefined) delete process.env.RATE_LIMIT_RELAXED;
        else process.env.RATE_LIMIT_RELAXED = previous;
    }
}

test('완화는 기본으로 꺼져 있다', () => {
    assert.equal(withFlag(undefined, rateLimitRelaxed), false);
    // 'true'만 켠다. '1'이나 'yes'가 통하면 오타 하나로 한도가 열린다.
    assert.equal(withFlag('1', rateLimitRelaxed), false);
    assert.equal(withFlag('TRUE', rateLimitRelaxed), false);
    assert.equal(withFlag('true', rateLimitRelaxed), true);
});

test('운영에서는 완화 플래그를 켠 채로 뜨지 못한다', () => {
    withFlag('true', () => {
        assert.throws(() => assertRateLimitPolicy('prod'), /RATE_LIMIT_RELAXED/);
        // dev/staging에서는 통과해야 한다.
        assert.doesNotThrow(() => assertRateLimitPolicy('dev'));
        assert.doesNotThrow(() => assertRateLimitPolicy(undefined));
    });
});

test('플래그가 꺼져 있으면 운영에서도 부팅을 막지 않는다', () => {
    withFlag(undefined, () => {
        assert.doesNotThrow(() => assertRateLimitPolicy('prod'));
    });
});
