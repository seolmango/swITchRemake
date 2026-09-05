import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import * as bcrypt from 'bcrypt';
import * as schema from '../database/schema';
import { auditContext } from '../admin/audit-log';
import { MfaSecurityService, totpAtStep } from './mfa-security.service';
import { MfaService } from './mfa.service';

class ChallengeRedis {
    readonly values = new Map<string, string>();

    async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
    async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
    async del(key: string): Promise<void> { this.values.delete(key); }
    async compareAndClaim(key: string, expected: string, claimKey: string, claimValue: string): Promise<number> {
        if (this.values.get(key) !== expected || this.values.has(claimKey)) return -1;
        this.values.delete(key);
        this.values.set(claimKey, claimValue);
        return 300_000;
    }
    async compareAndDelete(key: string, expected: string): Promise<boolean> {
        if (this.values.get(key) !== expected) return false;
        this.values.delete(key);
        return true;
    }
    async releaseClaim(claimKey: string, claimValue: string, key: string, value: string): Promise<boolean> {
        if (this.values.get(claimKey) !== claimValue) return false;
        this.values.delete(claimKey);
        this.values.set(key, value);
        return true;
    }
}

const config = new ConfigService({
    MFA_TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
    SESSION_IP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    MFA_TRUSTED_DEVICE_DAYS: '30',
});

function security(): MfaSecurityService { return new MfaSecurityService(config); }

test('로그인 도전값은 한 번만 소비되고 같은 TOTP 시간 칸도 다시 통과하지 않는다', async () => {
    const mfaSecurity = security();
    const secret = mfaSecurity.generateTotpSecret();
    const encryptedSecret = mfaSecurity.encryptTotpSecret(secret);
    let totpUpdates = 0;
    const db = {
        select: () => ({
            from: (table: unknown) => ({
                where: async () => table === schema.mfaSettings
                    ? [{ method: 'totp', encryptedSecret }]
                    : [],
            }),
        }),
        update: (table: unknown) => ({ set: () => ({ where: () => ({
            returning: async () => table === schema.mfaSettings && totpUpdates++ === 0 ? [{ userId: 7 }] : [],
        }) }) }),
    };
    const redis = new ChallengeRedis();
    const service = new MfaService(
        db as never,
        redis as never,
        {} as never,
        mfaSecurity,
        {} as never,
        config,
    );
    const challenge = await service.beginLoginChallenge(7, 3, 'totp');
    const anotherChallenge = await service.beginLoginChallenge(7, 3, 'totp');
    assert.equal(challenge.expiresIn, 300);
    const step = Math.floor(Date.now() / 30_000);
    assert.deepEqual(
        await service.completeLoginChallenge(challenge.challengeToken, totpAtStep(secret, step)),
        { userId: 7, securityEpoch: 3, method: 'totp' },
    );
    await assert.rejects(
        service.completeLoginChallenge(challenge.challengeToken, totpAtStep(secret, step)),
        (error: any) => error?.response?.code === 'INVALID_MFA_CHALLENGE',
    );
    await assert.rejects(
        service.completeLoginChallenge(anotherChallenge.challengeToken, totpAtStep(secret, step)),
        (error: any) => error?.response?.code === 'INVALID_SECOND_FACTOR',
    );
});

test('백업 코드는 bcrypt 해시와 원자적 used_at 갱신을 모두 통과한 첫 시도만 쓸 수 있다', async () => {
    const code = 'A1B2C3D4-ABCD-EFGH-IJKL-MNOP';
    const codeHash = await bcrypt.hash(code, 4);
    let backupUpdates = 0;
    const db = {
        select: () => ({
            from: (table: unknown) => ({
                where: async () => table === schema.mfaSettings
                    ? [{ method: 'totp', encryptedSecret: 'unused' }]
                    : table === schema.mfaBackupCodes
                        ? [{ id: 'backup-1', codeHash }]
                        : [],
            }),
        }),
        update: (table: unknown) => ({ set: () => ({ where: () => ({
            returning: async () => table === schema.mfaBackupCodes && backupUpdates++ === 0 ? [{ id: 'backup-1' }] : [],
        }) }) }),
    };
    const service = new MfaService(db as never, {} as never, {} as never, security(), {} as never, config);
    assert.deepEqual(await service.authorizeStepUp(7, code), { kind: 'verified', method: 'totp' });
    await assert.rejects(service.authorizeStepUp(7, code), (error: any) => error?.response?.code === 'INVALID_SECOND_FACTOR');
});

test('OTP 사용자의 비밀번호 재설정은 메일을 보내거나 메일 코드를 2차 수단으로 보지 않는다', async () => {
    const mfaSecurity = security();
    const secret = mfaSecurity.generateTotpSecret();
    const encryptedSecret = mfaSecurity.encryptTotpSecret(secret);
    let mailCalls = 0;
    const db = {
        select: () => ({ from: (table: unknown) => ({ where: async () => table === schema.mfaSettings
            ? [{ method: 'totp', encryptedSecret }]
            : [] }) }),
        update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    };
    const service = new MfaService(
        db as never,
        {} as never,
        { sendMfaCodeEmail: async () => { mailCalls += 1; return true; } } as never,
        mfaSecurity,
        {} as never,
        config,
    );
    await assert.rejects(service.authorizePasswordReset(7), (error: any) => error?.response?.code === 'MFA_REQUIRED');
    await assert.rejects(service.authorizePasswordReset(7, '000000'), (error: any) => error?.response?.code === 'INVALID_SECOND_FACTOR');
    assert.equal(mailCalls, 0);
});

test('끄기·백업 코드 재발급·신뢰 기기 해제는 올바른 2차 코드 전에는 쓰기 트랜잭션에 가지 않는다', async () => {
    const mfaSecurity = security();
    const encryptedSecret = mfaSecurity.encryptTotpSecret(mfaSecurity.generateTotpSecret());
    let transactions = 0;
    const db = {
        select: () => ({ from: () => ({ where: async () => [{ method: 'totp', encryptedSecret }] }) }),
        update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
        transaction: async () => { transactions += 1; },
    };
    const service = new MfaService(db as never, {} as never, {} as never, mfaSecurity, {} as never, config);
    await assert.rejects(service.disable(7, '000000', auditContext()), /Invalid or expired/);
    await assert.rejects(service.regenerateBackupCodes(7, '000000', auditContext()), /Invalid or expired/);
    await assert.rejects(service.revokeTrustedDevice(7, '11111111-1111-4111-8111-111111111111', '000000', undefined, auditContext()), /Invalid or expired/);
    assert.equal(transactions, 0);
});

test('신뢰 기기 조회 조건은 토큰 해시뿐 아니라 계정과 서버 만료 시각에 묶인다', async () => {
    let condition: SQL | undefined;
    const db = {
        select: () => ({ from: () => ({ where: async (value: SQL) => { condition = value; return [{ id: 'device' }]; } }) }),
    };
    const service = new MfaService(db as never, {} as never, {} as never, security(), {} as never, config);
    assert.equal(await service.isTrustedDevice(7, 'server-issued-token'), true);
    const query = new PgDialect().sqlToQuery(condition!);
    assert.ok(query.params.includes(7));
    assert.ok(query.params.includes(security().hashOpaqueToken('server-issued-token')));
    assert.match(query.sql, /"trusted_devices"\."expires_at" > \$/);
    assert.equal(query.params.includes('server-issued-token'), false);
});

test('신뢰 기기 원문 토큰은 서버가 발급해 쿠키용으로만 반환하고 DB에는 해시·고정 만료만 남긴다', async () => {
    let trustedRow: Record<string, unknown> | undefined;
    let auditRow: Record<string, unknown> | undefined;
    const tx = {
        delete: () => ({ where: async () => [] }),
        insert: (table: unknown) => ({
            values: (value: Record<string, unknown>) => {
                if (table === schema.trustedDevices) trustedRow = value;
                if (table === schema.adminAuditLog) auditRow = value;
                return { returning: async () => [{ id: '11111111-1111-4111-8111-111111111111' }] };
            },
        }),
    };
    const mfaSecurity = security();
    const service = new MfaService(
        {} as never,
        {} as never,
        {} as never,
        mfaSecurity,
        { deviceLabel: () => 'Chrome on Windows' } as never,
        config,
    );
    const before = Date.now();
    const issued = await service.registerTrustedDevice(7, 'raw user agent', tx as never);
    const after = Date.now();
    assert.equal(trustedRow!.userId, 7);
    assert.equal(trustedRow!.deviceLabel, 'Chrome on Windows');
    assert.equal(trustedRow!.tokenHash, mfaSecurity.hashOpaqueToken(issued.token));
    assert.equal(Object.values(trustedRow!).includes(issued.token), false);
    assert.ok(issued.expiresAt.getTime() >= before + 30 * 86_400_000);
    assert.ok(issued.expiresAt.getTime() <= after + 30 * 86_400_000);
    assert.equal(auditRow!.action, 'MFA_TRUSTED_DEVICE_ADDED');
});

test('메일 2차 인증을 켜면 백업 코드는 한 번 반환되고 DB에는 bcrypt 해시와 감사 기록만 남는다', async () => {
    const passwordHash = await bcrypt.hash('Password1!', 4);
    let backupRows: Array<{ codeHash: string }> = [];
    let auditRow: Record<string, unknown> | undefined;
    const user = { email: 'user@example.com', passwordHash, status: 'ACTIVE', securityEpoch: 3 };
    const tx = {
        select: () => ({
            from: (table: unknown) => table === schema.mfaSettings
                ? { where: async () => [] }
                : { where: () => ({ for: async () => [user] }) },
        }),
        insert: (table: unknown) => ({ values: async (value: any) => {
            if (table === schema.mfaBackupCodes) backupRows = value;
            if (table === schema.adminAuditLog) auditRow = value;
        } }),
    };
    const db = {
        select: () => ({ from: () => ({ where: async () => [user] }) }),
        transaction: async (run: (value: typeof tx) => unknown) => run(tx),
    };
    const service = new MfaService(db as never, {} as never, {} as never, security(), {} as never, config);
    const result = await service.enableEmail(7, 'Password1!', auditContext());
    assert.equal(result.backupCodes.length, 10);
    assert.equal(backupRows.length, 10);
    for (let index = 0; index < result.backupCodes.length; index++) {
        assert.notEqual(backupRows[index]!.codeHash, result.backupCodes[index]);
        assert.equal(await bcrypt.compare(result.backupCodes[index]!, backupRows[index]!.codeHash), true);
    }
    assert.equal(auditRow!.action, 'MFA_ENABLED');
});
