import assert from 'node:assert/strict';
import test from 'node:test';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

test('비밀번호가 맞아도 신뢰 기기가 아니면 세션·access·refresh 없이 2차 도전값만 돌려준다', async () => {
    const passwordHash = await bcrypt.hash('Password1!', 4);
    let transactions = 0;
    const user = {
        id: 7,
        email: 'user@example.com',
        nickname: 'Player',
        passwordHash,
        accountStatus: 'ACTIVE',
        securityEpoch: 2,
    };
    const db = {
        select: () => ({ from: () => ({ where: async () => [user] }) }),
        transaction: async () => { transactions += 1; throw new Error('must not create a session'); },
    };
    const mfa = {
        getMethod: async () => 'totp',
        isTrustedDevice: async () => false,
        beginLoginChallenge: async () => ({
            mfaRequired: true,
            challengeToken: 'a'.repeat(64) + '.server-challenge',
            method: 'totp',
            expiresIn: 300,
        }),
    };
    const service = new AuthService(
        db as never, {} as never, {} as never, {} as never, {} as never,
        {} as never, {} as never,
        { reconcileLoginStatus: async () => 'ACTIVE' } as never,
        mfa as never,
    );
    const result = await service.login({ email: user.email, password: 'Password1!' }, { ip: '203.0.113.1' });
    assert.equal(result.mfaRequired, true);
    assert.equal('accessToken' in result, false);
    assert.equal('refreshToken' in result, false);
    assert.equal(transactions, 0);
});

test('2차 도전값 완료 뒤에만 기존 세션 생성 경로가 토큰과 DB 세션을 함께 만든다', async () => {
    const inserted: unknown[] = [];
    const tx = {
        select: () => ({ from: () => ({ where: () => ({ for: async () => [{
            status: 'ACTIVE', email: 'user@example.com', nickname: 'Player', securityEpoch: 2,
        }] }) }) }),
        insert: (table: unknown) => ({ values: async (values: unknown) => { inserted.push({ table, values }); } }),
    };
    const db = { transaction: async (run: (value: typeof tx) => unknown) => run(tx) };
    const jwt = { sign: (payload: { type: string }) => `${payload.type}-token` };
    const configService = { get: (key: string) => key.includes('EXPIRATION') ? 900 : 'secret' };
    const mfa = {
        completeLoginChallenge: async () => ({ userId: 7, securityEpoch: 2, method: 'totp' }),
        assertLoginAuthorized: async () => undefined,
    };
    const service = new AuthService(
        db as never, {} as never, {} as never, jwt as never, configService as never,
        {
            protectIp: () => ({ ipHmac: 'h'.repeat(64), ipEncrypted: 'v1:i:t:c' }),
            hashRefreshToken: () => 'r'.repeat(64),
            deviceLabel: () => 'Browser on OS',
        } as never,
        {} as never, {} as never, mfa as never,
    );
    const result = await service.completeMfaLogin('challenge', '123456', false, { ip: '203.0.113.1' });
    assert.equal(result.accessToken, 'access-token');
    assert.equal(result.refreshToken, 'refresh-token');
    assert.equal(inserted.length, 1);
});
