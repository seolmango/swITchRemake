import assert from 'node:assert/strict';
import test from 'node:test';
import { EmailAuthType } from './dto/email-auth.dto';
import {
    claimVerificationCode,
    issueVerificationCode,
    releaseVerificationCodeClaim,
} from './verification-code';

class FakeRedis {
    readonly values = new Map<string, string>();
    readonly ttl = new Map<string, number>();
    readonly increments = new Map<string, number>();

    async set(key: string, value: string, ttlSeconds?: number) {
        this.values.set(key, value);
        if (ttlSeconds) this.ttl.set(key, ttlSeconds * 1000);
    }
    async get(key: string) { return this.values.get(key) ?? null; }
    async del(key: string) { this.values.delete(key); }
    async setIfAbsent(key: string, value: string, ttlSeconds: number) {
        if (this.values.has(key)) return false;
        await this.set(key, value, ttlSeconds);
        return true;
    }
    async incrementWithTtl(key: string) {
        const count = (this.increments.get(key) ?? 0) + 1;
        this.increments.set(key, count);
        return count;
    }
    async compareAndClaim(key: string, expected: string, lease: string, claimId: string) {
        if (this.values.has(lease) || this.values.get(key) !== expected) return -1;
        const remaining = this.ttl.get(key) ?? 300_000;
        this.values.delete(key);
        this.values.set(lease, claimId);
        return remaining;
    }
    async compareAndDelete(key: string, expected: string) {
        if (this.values.get(key) !== expected) return false;
        this.values.delete(key);
        return true;
    }
    async releaseClaim(lease: string, claimId: string, key: string, value: string, ttlMs: number) {
        if (this.values.get(lease) !== claimId) return false;
        this.values.delete(lease);
        this.values.set(key, value);
        this.ttl.set(key, ttlMs);
        return true;
    }
}

test('같은 purpose와 정규화 이메일의 cooldown 동안 기존 코드를 덮어쓰지 않는다', async () => {
    const redis = new FakeRedis();
    const first = await issueVerificationCode(redis as never, EmailAuthType.RESET_PASSWORD, 'user@example.com');
    const second = await issueVerificationCode(redis as never, EmailAuthType.RESET_PASSWORD, 'user@example.com');
    redis.values.delete('auth:code-cooldown:reset-password:user@example.com');
    const afterCooldown = await issueVerificationCode(redis as never, EmailAuthType.RESET_PASSWORD, 'user@example.com');
    assert.match(first!, /^\d{6}$/);
    assert.equal(second, null);
    assert.equal(afterCooldown, null);
    assert.equal(redis.values.get('auth:code:reset-password:user@example.com'), first);
});

test('인증 코드는 한 요청만 claim하고 실패하면 원래 남은 수명으로 돌려놓는다', async () => {
    const redis = new FakeRedis();
    await redis.set('auth:code:signup:user@example.com', '123456', 300);
    const first = await claimVerificationCode(redis as never, EmailAuthType.SIGNUP, 'user@example.com', '123456');
    const concurrent = await claimVerificationCode(redis as never, EmailAuthType.SIGNUP, 'user@example.com', '123456');
    assert.ok(first);
    assert.equal(concurrent, null);
    await releaseVerificationCodeClaim(redis as never, first!);
    assert.equal(redis.values.get('auth:code:signup:user@example.com'), '123456');
    assert.equal(redis.ttl.get('auth:code:signup:user@example.com'), 300_000);
});

test('코드 발급은 cooldown 외에도 수신 주소별 분·시간 총량을 Redis에서 센다', async () => {
    const redis = new FakeRedis();
    const email = 'limited@example.com';
    const clearIssuedCodeAndCooldown = () => {
        redis.values.delete(`auth:code:signup:${email}`);
        redis.values.delete(`auth:code-cooldown:signup:${email}`);
    };

    for (let count = 0; count < 3; count++) {
        assert.match((await issueVerificationCode(redis as never, EmailAuthType.SIGNUP, email))!, /^\d{6}$/);
        clearIssuedCodeAndCooldown();
    }
    assert.equal(await issueVerificationCode(redis as never, EmailAuthType.SIGNUP, email), null);

    const hourly = new FakeRedis();
    for (let count = 0; count < 10; count++) {
        assert.match((await issueVerificationCode(hourly as never, EmailAuthType.DELETE, email))!, /^\d{6}$/);
        hourly.values.delete(`auth:code:delete:${email}`);
        hourly.values.delete(`auth:code-cooldown:delete:${email}`);
        hourly.increments.delete(`auth:code-issue-minute:delete:${email}`);
    }
    assert.equal(await issueVerificationCode(hourly as never, EmailAuthType.DELETE, email), null);
});
