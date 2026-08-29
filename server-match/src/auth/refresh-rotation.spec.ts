import assert from 'node:assert/strict';
import test from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

const OLD_SESSION_ID = '11111111-1111-4111-8111-111111111111';
const SUCCESSOR_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_SESSION_ID = '33333333-3333-4333-8333-333333333333';

interface FakeSession {
    id: string;
    userId: number;
    refreshTokenHash: string;
    expiresAt: Date;
    revokedAt: Date | null;
    lastUsedAt: Date;
}

function session(id: string, revokedAt: Date | null = null): FakeSession {
    return {
        id,
        userId: 7,
        refreshTokenHash: id === OLD_SESSION_ID ? 'hash:old-refresh' : `hash:${id}`,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt,
        lastUsedAt: new Date(0),
    };
}

function makeHarness(options: { grace: string | null; tokenExpired?: boolean }) {
    const oldSession = session(OLD_SESSION_ID, new Date(Date.now() - 1_000));
    const successorSession = session(SUCCESSOR_SESSION_ID);
    const otherSession = session(OTHER_SESSION_ID);
    const sessions = [oldSession, successorSession, otherSession];
    const inserted: FakeSession[] = [];
    const redisWrites: Array<{ key: string; value: string; ttlSeconds?: number }> = [];
    const user = {
        id: 7,
        email: 'player@example.com',
        nickname: 'Player',
        accountStatus: 'ACTIVE',
    };
    let txSelectCount = 0;

    const tx = {
        select: () => {
            txSelectCount++;
            const rows = txSelectCount === 1
                ? [user]
                : txSelectCount === 2
                    ? [oldSession]
                    : [successorSession];
            return {
                from: () => ({
                    where: () => ({ for: async () => rows }),
                }),
            };
        },
        update: () => ({
            set: (values: Partial<FakeSession>) => ({
                where: async () => {
                    if (values.lastUsedAt) {
                        Object.assign(successorSession, values);
                        return;
                    }
                    for (const current of sessions) {
                        if (!current.revokedAt) Object.assign(current, values);
                    }
                },
            }),
        }),
        insert: () => ({
            values: async (values: FakeSession) => {
                inserted.push({ ...values, revokedAt: null });
            },
        }),
    };
    const db = {
        select: () => ({
            from: () => ({ where: async () => [user] }),
        }),
        transaction: async (callback: (transaction: typeof tx) => unknown) => callback(tx),
    };
    const redis = {
        get: async (key: string) => key === `auth:rotate:${OLD_SESSION_ID}` ? options.grace : null,
        set: async (key: string, value: string, ttlSeconds?: number) => {
            redisWrites.push({ key, value, ttlSeconds });
        },
    };
    const jwt = {
        verify: () => ({
            sub: user.id,
            email: user.email,
            sid: OLD_SESSION_ID,
            type: 'refresh',
            exp: Math.floor(Date.now() / 1000) + (options.tokenExpired ? -60 : 60),
        }),
        sign: (payload: { sid: string; type: string }) => `${payload.type}:${payload.sid}`,
    };
    const config = {
        get: (key: string) => key.includes('EXPIRATION') ? 3600 : 'secret',
    };
    const security = {
        hashRefreshToken: (token: string) => `hash:${token}`,
        protectIp: () => ({ ipHmac: 'ip-hmac', ipEncrypted: 'ip-encrypted' }),
        deviceLabel: () => 'browser',
    };
    const sessionService = { purgeExpiredEncryptedIps: async () => undefined };
    const sanctions = { reconcileLoginStatus: async () => 'ACTIVE' };
    const service = new AuthService(
        db as never, redis as never, {} as never, jwt as never, config as never,
        security as never, sessionService as never, sanctions as never,
    );

    return { service, sessions, inserted, redisWrites };
}

test('유예 내 옛 토큰 경합 회전', async () => {
    const harness = makeHarness({ grace: SUCCESSOR_SESSION_ID });

    const result = await harness.service.refresh('old-refresh', { ip: '203.0.113.4' });

    assert.match(result.refreshToken, /^refresh:/);
    assert.ok(harness.sessions[1].revokedAt);
    assert.equal(harness.sessions[2].revokedAt, null);
    assert.equal(harness.inserted.length, 1);
    // 옛 세션 표도 새 세션을 가리켜야 같은 옛 토큰이 한 번 더 와도 이어진다.
    assert.deepEqual(harness.redisWrites, [
        { key: `auth:rotate:${SUCCESSOR_SESSION_ID}`, value: harness.inserted[0].id, ttlSeconds: 10 },
        { key: `auth:rotate:${OLD_SESSION_ID}`, value: harness.inserted[0].id, ttlSeconds: 10 },
    ]);
});

test('유예 없는 옛 토큰 전체 해지', async () => {
    const harness = makeHarness({ grace: null });

    await assert.rejects(
        harness.service.refresh('old-refresh', { ip: '203.0.113.4' }),
        UnauthorizedException,
    );

    assert.ok(harness.sessions.every((current) => current.revokedAt));
    assert.equal(harness.inserted.length, 0);
    assert.equal(harness.redisWrites.length, 0);
});

test('만료 토큰은 유예 무시', async () => {
    const harness = makeHarness({ grace: SUCCESSOR_SESSION_ID, tokenExpired: true });

    await assert.rejects(
        harness.service.refresh('old-refresh', { ip: '203.0.113.4' }),
        UnauthorizedException,
    );

    assert.equal(harness.sessions[1].revokedAt, null);
    assert.equal(harness.sessions[2].revokedAt, null);
    assert.equal(harness.inserted.length, 0);
    assert.equal(harness.redisWrites.length, 0);
});
