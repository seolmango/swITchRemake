import assert from 'node:assert/strict';
import test from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import * as schema from '../database/schema';

const OLD_SESSION_ID = '11111111-1111-4111-8111-111111111111';
const FAMILY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_FAMILY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface FakeSession {
    id: string;
    userId: number;
    refreshTokenHash: string;
    expiresAt: Date;
    revokedAt: Date | null;
    lastUsedAt: Date;
    familyId: string;
    generation: number;
}

function makeHarness(options: { revoked?: boolean; cached?: Record<string, string>; tokenExpired?: boolean } = {}) {
    const oldSession: FakeSession = {
        id: OLD_SESSION_ID,
        userId: 7,
        refreshTokenHash: 'hash:old-refresh',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: options.revoked ? new Date(Date.now() - 1_000) : null,
        lastUsedAt: new Date(0),
        familyId: FAMILY_ID,
        generation: 4,
    };
    const successor: FakeSession = { ...oldSession, id: '22222222-2222-4222-8222-222222222222', generation: 5 };
    const unrelated: FakeSession = {
        ...oldSession,
        id: '33333333-3333-4333-8333-333333333333',
        familyId: OTHER_FAMILY_ID,
        generation: 0,
        revokedAt: null,
    };
    const sessions = [oldSession, ...(options.revoked ? [successor] : []), unrelated];
    const inserted: FakeSession[] = [];
    const auditEvents: Array<Record<string, unknown>> = [];
    const redisWrites: Array<{ key: string; value: string; ttlSeconds?: number }> = [];
    const user = {
        id: 7,
        email: 'player@example.com',
        nickname: 'Player',
        accountStatus: 'ACTIVE',
        securityEpoch: 2,
    };
    let txSelectCount = 0;
    let transactionCount = 0;
    const tx = {
        select: () => {
            txSelectCount++;
            const rows = txSelectCount === 1 ? [user] : [oldSession];
            return { from: () => ({ where: () => ({ for: async () => rows }) }) };
        },
        update: () => ({
            set: (values: Partial<FakeSession>) => ({
                where: async () => {
                    if (values.lastUsedAt) Object.assign(oldSession, values);
                    else for (const current of sessions) {
                        if (current.familyId === FAMILY_ID && !current.revokedAt) Object.assign(current, values);
                    }
                },
            }),
        }),
        insert: (table: unknown) => ({ values: async (values: FakeSession | Record<string, unknown>) => {
            if (table === schema.authSecurityEvents) auditEvents.push(values as Record<string, unknown>);
            else inserted.push({ ...(values as FakeSession), revokedAt: null });
        } }),
    };
    const db = {
        select: () => ({ from: () => ({ where: async () => [user] }) }),
        transaction: async (callback: (transaction: typeof tx) => unknown) => {
            transactionCount++;
            return callback(tx);
        },
    };
    const redis = {
        get: async (key: string) => options.cached?.[key] ?? null,
        set: async (key: string, value: string, ttlSeconds?: number) => redisWrites.push({ key, value, ttlSeconds }),
        compareAndDelete: async () => true,
    };
    let sequence = 0;
    const jwt = {
        verify: () => ({
            sub: user.id,
            email: user.email,
            sid: OLD_SESSION_ID,
            fid: FAMILY_ID,
            gen: 4,
            sev: 2,
            type: 'refresh',
            exp: Math.floor(Date.now() / 1000) + (options.tokenExpired ? -60 : 60),
        }),
        sign: (payload: { sid: string; type: string }) => `${payload.type}:${payload.sid}:${++sequence}`,
    };
    const config = { get: (key: string) => key.includes('EXPIRATION') ? 3600 : 'secret' };
    const security = {
        hashRefreshToken: (token: string) => `hash:${token}`,
        protectIp: () => ({ ipHmac: 'ip-hmac', ipEncrypted: 'ip-encrypted' }),
        deviceLabel: () => 'browser',
    };
    const sanctions = { reconcileLoginStatus: async () => 'ACTIVE' };
    const service = new AuthService(
        db as never, redis as never, {} as never, jwt as never, config as never,
        security as never, {} as never, sanctions as never, {} as never,
    );
    return { service, sessions, inserted, auditEvents, redisWrites, transactionCount: () => transactionCount };
}

test('유예 내 옛 토큰은 최초 회전 응답을 그대로 재전송하고 새 세션을 만들지 않는다', async () => {
    const cached = { accessToken: 'same-access', refreshToken: 'same-refresh', nickname: 'Player' };
    const harness = makeHarness({
        revoked: true,
        cached: { 'auth:rotate-result:hash:old-refresh': JSON.stringify(cached) },
    });

    assert.deepEqual(await harness.service.refresh('old-refresh', { ip: '203.0.113.4' }), cached);
    assert.equal(harness.transactionCount(), 0);
    assert.equal(harness.inserted.length, 0);
    assert.equal(harness.auditEvents.length, 0);
});

test('유예가 끝난 옛 토큰 재사용은 같은 family 전체만 폐기한다', async () => {
    const harness = makeHarness({ revoked: true });
    await assert.rejects(
        harness.service.refresh('old-refresh', { ip: '203.0.113.4' }),
        UnauthorizedException,
    );
    assert.ok(harness.sessions.filter((item) => item.familyId === FAMILY_ID).every((item) => item.revokedAt));
    assert.equal(harness.sessions.find((item) => item.familyId === OTHER_FAMILY_ID)?.revokedAt, null);
    assert.equal(harness.inserted.length, 0);
    assert.deepEqual(harness.auditEvents, [{
        userId: 7,
        event: 'refresh-token-reuse',
        familyId: FAMILY_ID,
        generation: 4,
    }]);
});

test('정상 회전은 family와 세대를 이어받고 최초 응답을 짧게 저장한다', async () => {
    const harness = makeHarness();
    const response = await harness.service.refresh('old-refresh', { ip: '203.0.113.4' });
    assert.equal(harness.inserted.length, 1);
    assert.equal(harness.inserted[0].familyId, FAMILY_ID);
    assert.equal(harness.inserted[0].generation, 5);
    assert.deepEqual(harness.redisWrites, [{
        key: 'auth:rotate-result:hash:old-refresh',
        value: JSON.stringify(response),
        ttlSeconds: 10,
    }]);
});

test('만료 토큰은 캐시된 회전 결과가 있어도 거절한다', async () => {
    const harness = makeHarness({
        tokenExpired: true,
        cached: { 'auth:rotate-result:hash:old-refresh': JSON.stringify({ accessToken: 'a', refreshToken: 'r', nickname: 'n' }) },
    });
    await assert.rejects(harness.service.refresh('old-refresh', { ip: '203.0.113.4' }), UnauthorizedException);
    assert.equal(harness.transactionCount(), 0);
});
