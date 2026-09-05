import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService, passwordHashForComparison } from './auth.service';

test('없는 이메일도 실제 dummy bcrypt 해시를 비교 대상으로 쓴다', async () => {
    const dummy = passwordHashForComparison(undefined);
    assert.match(dummy, /^\$2[aby]\$/);
    assert.equal(await bcrypt.compare('Password1!', dummy), false);
});

test('비밀번호 비교 뒤 행 잠금에서 해시가 달라졌으면 세션을 만들지 않는다', async () => {
    const passwordHash = await bcrypt.hash('Password1!', 4);
    let inserted = false;
    const initialUser = {
        id: 7, email: 'user@example.com', nickname: 'User', passwordHash,
        accountStatus: 'ACTIVE', securityEpoch: 0,
    };
    const changedUser = { status: 'ACTIVE', passwordHash: `${passwordHash}-changed`, securityEpoch: 1 };
    const tx = {
        select: () => ({ from: () => ({ where: () => ({ for: async () => [changedUser] }) }) }),
        insert: () => ({ values: async () => { inserted = true; } }),
    };
    const db = {
        select: () => ({ from: () => ({ where: async () => [initialUser] }) }),
        transaction: async (run: (value: typeof tx) => unknown) => run(tx),
    };
    const service = new AuthService(
        db as never, {} as never, {} as never, {} as never,
        {} as never,
        { protectIp: () => ({ ipHmac: 'h', ipEncrypted: 'e' }) } as never,
        {} as never,
        { reconcileLoginStatus: async () => 'ACTIVE' } as never,
        { getMethod: async () => null, assertLoginAuthorized: async () => undefined } as never,
    );
    await assert.rejects(
        service.login({ email: initialUser.email, password: 'Password1!' }, { ip: '203.0.113.1' }),
        UnauthorizedException,
    );
    assert.equal(inserted, false);
});

test('비밀번호 복구는 사용자 잠금, 해시·epoch 갱신, 전체 세션 폐기를 한 트랜잭션에서 한다', async () => {
    const events: string[] = [];
    const tx = {
        select: () => ({
            from: () => ({ where: () => ({ for: async () => {
                events.push('lock-user');
                return [{ id: 7, accountStatus: 'ACTIVE' }];
            } }) }),
        }),
        update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => {
            assert.ok('passwordHash' in values);
            assert.ok('securityEpoch' in values);
            events.push('update-user');
        } }) }),
    };
    const db = {
        select: () => ({ from: () => ({ where: async () => [{ id: 7, accountStatus: 'ACTIVE' }] }) }),
        transaction: async (run: (value: typeof tx) => unknown) => {
            events.push('begin');
            const result = await run(tx);
            events.push('commit');
            return result;
        },
    };
    const redis = {
        get: async () => '123456',
        compareAndClaim: async () => 300_000,
        compareAndDelete: async () => true,
        del: async () => undefined,
        releaseClaim: async () => true,
    };
    const sessions = { revokeAll: async (_userId: number, usedTx: unknown) => {
        assert.equal(usedTx, tx);
        events.push('revoke-all');
        return 1;
    } };
    const service = new AuthService(
        db as never, redis as never, {} as never, {} as never, {} as never,
        {} as never, sessions as never, {} as never,
        {
            authorizePasswordReset: async () => {
                events.push('authorize-mfa');
                return { kind: 'not-enabled' };
            },
            assertAccountAuthorizationCurrent: async () => { events.push('assert-mfa-under-lock'); },
        } as never,
    );
    assert.deepEqual(
        await service.resetPassword({ email: 'user@example.com', code: '123456', newPassword: 'Newpass1!' }),
        { reset: true },
    );
    assert.deepEqual(events, ['authorize-mfa', 'begin', 'lock-user', 'assert-mfa-under-lock', 'update-user', 'revoke-all', 'commit']);
});

test('2차 인증 계정의 비밀번호 복구는 2차 확인 전에는 갱신 트랜잭션에 들어가지 않고 메일 코드를 돌려놓는다', async () => {
    let released = false;
    let transactions = 0;
    const db = {
        select: () => ({ from: () => ({ where: async () => [{ id: 7, accountStatus: 'ACTIVE' }] }) }),
        transaction: async () => { transactions += 1; },
    };
    const redis = {
        get: async () => '123456',
        compareAndClaim: async () => 300_000,
        releaseClaim: async () => { released = true; return true; },
    };
    const service = new AuthService(
        db as never, redis as never, {} as never, {} as never, {} as never,
        {} as never, {} as never, {} as never,
        {
            authorizePasswordReset: async () => {
                throw new HttpException({ code: 'MFA_REQUIRED' }, HttpStatus.UNAUTHORIZED);
            },
        } as never,
    );
    await assert.rejects(
        service.resetPassword({ email: 'user@example.com', code: '123456', newPassword: 'Newpass1!' }),
        (error: any) => error?.response?.code === 'MFA_REQUIRED',
    );
    assert.equal(transactions, 0);
    assert.equal(released, true);
});
