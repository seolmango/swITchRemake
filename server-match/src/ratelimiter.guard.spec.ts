import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { AGGREGATE_ACTOR_LIMIT, AGGREGATE_IP_LIMIT, PreAuthIpRateLimiterGuard, RateLimiterGuard, assertRateLimitPolicy, rateLimitRelaxed } from './ratelimiter.guard';
import { createHash } from 'node:crypto';

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

function guardHarness(request: Record<string, any>, limit = 2) {
    const counts = new Map<string, number>();
    const redis = {
        incrementWithTtl: async (key: string) => {
            const next = (counts.get(key) ?? 0) + 1;
            counts.set(key, next);
            return next;
        },
        ttlMilliseconds: async () => 60_000,
    };
    const options = { limit, ttl: 60_000 };
    const reflector = { get: () => options };
    const security = { hmacIp: (ip: string) => `hmac:${ip}` };
    const context = {
        getHandler: () => request.handler ?? function testRoute() {},
        getClass: () => class TestController {},
        switchToHttp: () => ({ getRequest: () => request }),
    };
    return {
        redis,
        counts,
        options,
        context,
        pre: new PreAuthIpRateLimiterGuard(reflector as never, redis as never, security as never),
        actor: new RateLimiterGuard(reflector as never, redis as never),
        anotherActor: new RateLimiterGuard(reflector as never, redis as never),
    };
}

test('unavailable rate store fails closed with 503 and admits normal requests after recovery', async () => {
    const harness = guardHarness({ ip: '203.0.113.15' });
    const normal = harness.redis.incrementWithTtl;
    harness.redis.incrementWithTtl = async () => { throw new Error('store disconnected'); };
    await assert.rejects(harness.pre.canActivate(harness.context as never), ServiceUnavailableException);
    assert.equal(harness.counts.size, 0);
    harness.redis.incrementWithTtl = normal;
    assert.equal(await harness.pre.canActivate(harness.context as never), true);
});

test('a stalled rate counter rejects with 503 within the HTTP dependency deadline', async () => {
    const harness = guardHarness({ ip: '203.0.113.16' });
    harness.redis.incrementWithTtl = () => new Promise<number>(() => {});
    const started = Date.now();
    await assert.rejects(harness.pre.canActivate(harness.context as never), ServiceUnavailableException);
    assert.ok(Date.now() - started < 3_000);
    assert.equal(harness.counts.size, 0);
});

test('인증 요청은 IP, actor, 정규화한 대상 이메일 버킷을 모두 쓴다', async () => {
    const harness = guardHarness({
        ip: '203.0.113.7',
        headers: { authorization: 'Bearer token' },
        user: { id: 'g:one', guest: true },
        body: { email: ' Victim@Example.COM ' },
    });
    await harness.pre.canActivate(harness.context as never);
    await harness.actor.canActivate(harness.context as never);
    assert.deepEqual([...harness.counts.keys()].sort(), [
        'auth-rate:actor:guest:g:one',
        'auth-rate:ip:hmac:203.0.113.7',
        'auth-rate:route:TestController.testRoute:actor:guest:g:one',
        'auth-rate:route:TestController.testRoute:ip:hmac:203.0.113.7',
        'auth-rate:target:victim@example.com',
    ]);
});

test('서로 다른 가드 인스턴스도 같은 Redis 대상 버킷의 총 한도를 공유한다', async () => {
    const harness = guardHarness({ ip: '203.0.113.7', headers: {}, body: { email: 'victim@example.com' } }, 1);
    for (let attempt = 0; attempt < 5; attempt++) await harness.actor.canActivate(harness.context as never);
    await assert.rejects(harness.anotherActor.canActivate(harness.context as never), HttpException);
});

test('잘못된 Bearer도 JWT 검증 전에 IP 버킷 비용을 낸다', async () => {
    const harness = guardHarness({ ip: '203.0.113.8', headers: { authorization: 'Bearer invalid' } });
    await harness.pre.canActivate(harness.context as never);
    assert.equal(harness.counts.get('auth-rate:ip:hmac:203.0.113.8'), 1);
});

test('게스트와 계정 actor는 같은 기능 한도를 쓰고 IP 버킷은 NAT 배수로 더 넓다', async () => {
    for (const user of [{ id: 'g:one', guest: true }, { id: 7, guest: false }]) {
        const harness = guardHarness({ ip: '203.0.113.9', user }, 1);
        await harness.actor.canActivate(harness.context as never);
        await assert.rejects(harness.actor.canActivate(harness.context as never), HttpException);
    }

    const ip = guardHarness({ ip: '203.0.113.10' }, 1);
    for (let count = 0; count < 4; count++) await ip.pre.canActivate(ip.context as never);
    await assert.rejects(ip.pre.canActivate(ip.context as never), HttpException);
});

test('2차 로그인 실패는 도전값 신원과 계정별 대상 표지를 함께 세고 새 표지로 변조할 수 없다', async () => {
    const target = 'a'.repeat(64);
    const challenge = `${target}.${'B'.repeat(43)}`;
    const harness = guardHarness({ ip: '203.0.113.11', body: { challengeToken: challenge } });
    await harness.actor.canActivate(harness.context as never);
    assert.deepEqual([...harness.counts.keys()].sort(), [
        `auth-rate:actor:mfa-challenge:${createHash('sha256').update(challenge).digest('hex')}`,
        `auth-rate:target:mfa:${target}`,
    ]);
});

test('로그인 뒤 2차 설정 변경은 actor와 대상 계정 버킷을 별도로 센다', async () => {
    const harness = guardHarness({
        ip: '203.0.113.12',
        user: { id: 7, guest: false },
        routeOptions: { url: '/users/me/mfa' },
        body: { code: '123456' },
    });
    await harness.actor.canActivate(harness.context as never);
    assert.deepEqual([...harness.counts.keys()].sort(), [
        'auth-rate:actor:account:7',
        'auth-rate:route:TestController.testRoute:actor:account:7',
        'auth-rate:target:account:7',
    ]);
});

test('room/admin reads do not exhaust the first authentication refresh for the same NAT or actor', async () => {
    const request = { ip: '203.0.113.20', user: { id: 7, guest: false }, handler: function readOverview() {}, method: 'GET' };
    const harness = guardHarness(request, 60);
    for (let count = 0; count < 30; count++) {
        await harness.pre.canActivate(harness.context as never);
        await harness.actor.canActivate(harness.context as never);
    }
    request.handler = function refresh() {};
    request.method = 'POST';
    harness.options.limit = 5;
    assert.equal(await harness.pre.canActivate(harness.context as never), true);
    assert.equal(await harness.actor.canActivate(harness.context as never), true);
});

test('account profile reads do not exhaust a later password-change actor bucket', async () => {
    const request = { ip: '203.0.113.26', user: { id: 7, guest: false }, handler: function readProfile() {} };
    const harness = guardHarness(request, 60);
    for (let count = 0; count < 30; count++) await harness.actor.canActivate(harness.context as never);
    request.handler = function changePassword() {};
    harness.options.limit = 5;
    assert.equal(await harness.actor.canActivate(harness.context as never), true);
});

test('route limits remain enforced and concrete match IDs do not create new buckets', async () => {
    const request = { ip: '203.0.113.21', user: { id: 7, guest: false }, handler: function getMatch() {}, url: '/matches/first', routeOptions: { url: '/matches/:id' } };
    const harness = guardHarness(request, 1);
    await harness.pre.canActivate(harness.context as never);
    await harness.actor.canActivate(harness.context as never);
    request.url = '/matches/second';
    await assert.rejects(harness.actor.canActivate(harness.context as never), HttpException);
    for (let count = 0; count < 3; count++) {
        request.url = `/matches/rotated-${count}`;
        await harness.pre.canActivate(harness.context as never);
    }
    request.url = '/matches/still-same-handler';
    await assert.rejects(harness.pre.canActivate(harness.context as never), HttpException);
});

test('fixed aggregate IP and actor caps remain enforced when requests spread across handlers', async () => {
    const request = { ip: '203.0.113.22', user: { id: 7, guest: false }, handler: function first() {} };
    const harness = guardHarness(request, 60);
    harness.counts.set('auth-rate:ip:hmac:203.0.113.22', AGGREGATE_IP_LIMIT);
    await assert.rejects(harness.pre.canActivate(harness.context as never), HttpException);
    harness.counts.set('auth-rate:actor:account:7', AGGREGATE_ACTOR_LIMIT);
    request.handler = function second() {};
    await assert.rejects(harness.actor.canActivate(harness.context as never), HttpException);
});

test('MFA status reads do not spend the shared second-factor attempt budget', async () => {
    const request = { ip: '203.0.113.23', user: { id: 7, guest: false }, method: 'GET', handler: function mfaStatus() {}, routeOptions: { url: '/users/me/mfa' }, body: {} };
    const harness = guardHarness(request, 60);
    for (let count = 0; count < 30; count++) await harness.actor.canActivate(harness.context as never);
    assert.equal(harness.counts.has('auth-rate:target:account:7'), false);
    request.method = 'DELETE';
    request.handler = function disableMfa() {};
    harness.options.limit = 5;
    await harness.actor.canActivate(harness.context as never);
    assert.equal(harness.counts.get('auth-rate:target:account:7'), 1);
});

test('changing authentication route or MFA challenge does not reset attack-target caps', async () => {
    const request = { ip: '203.0.113.24', handler: function login() {}, body: { email: 'victim@example.com', challengeToken: '' } };
    const harness = guardHarness(request, 60);
    for (let count = 0; count < 5; count++) await harness.actor.canActivate(harness.context as never);
    request.handler = function resetPassword() {};
    request.body.email = ' Victim@EXAMPLE.com ';
    await assert.rejects(harness.actor.canActivate(harness.context as never), HttpException);
    const mfaRequest = { ip: '203.0.113.25', handler: function loginMfa() {}, body: { challengeToken: '' } };
    const mfa = guardHarness(mfaRequest, 60);
    for (let count = 0; count < 5; count++) {
        mfaRequest.body.challengeToken = `${'a'.repeat(64)}.${String(count).repeat(43)}`;
        await mfa.actor.canActivate(mfa.context as never);
    }
    mfaRequest.handler = function resendMfa() {};
    mfaRequest.body.challengeToken = `${'a'.repeat(64)}.${'B'.repeat(43)}`;
    await assert.rejects(mfa.actor.canActivate(mfa.context as never), HttpException);
});
