import assert from 'node:assert/strict';
import test from 'node:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { auditContext } from '../admin/audit-log';
import * as schema from '../database/schema';
import { SanctionService } from './sanction.service';

const dialect = new PgDialect();

test('재가입 차단 조회는 이메일 원문이 아니라 HMAC만 DB 조건으로 보낸다', async () => {
    let condition: SQL | undefined;
    const db = {
        select: () => ({
            from: () => ({
                leftJoin: () => ({
                    where: (value: SQL) => {
                        condition = value;
                        return { limit: async () => [{ id: 'sanction-1' }] };
                    },
                }),
            }),
        }),
    };
    const service = new SanctionService(db as never, {
        hmacEmail: () => 'a'.repeat(64),
    } as never);

    assert.equal(await service.isEmailRegistrationBlocked('Secret@Example.com'), true);
    const compiled = dialect.sqlToQuery(condition!);
    assert.ok(compiled.params.includes('a'.repeat(64)));
    assert.equal(compiled.params.includes('Secret@Example.com'), false);
});

test('탈퇴는 한 트랜잭션에서 개인정보·누적치·동의를 지우고 전적 연결과 세션을 끊는다', async () => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const deletes: unknown[] = [];
    const audits: Record<string, unknown>[] = [];
    const statements: SQL[] = [];
    const tx = {
        select: () => ({
            from: (table: unknown) => table === schema.mfaSettings
                ? { where: async () => [] }
                : {
                    where: () => ({
                        for: async () => [{ status: 'ACTIVE', email: 'User@Example.com' }],
                    }),
                },
        }),
        execute: async (query: SQL) => { statements.push(query); return []; },
        update: (table: unknown) => ({
            set: (values: Record<string, unknown>) => {
                updates.push({ table, values });
                return { where: async () => [] };
            },
        }),
        delete: (table: unknown) => ({
            where: async () => { deletes.push(table); return []; },
        }),
        insert: (table: unknown) => ({
            values: async (value: Record<string, unknown>) => {
                if (table === schema.adminAuditLog) audits.push(value);
                return [];
            },
        }),
    };
    let transactions = 0;
    const db = {
        transaction: async (run: (transaction: typeof tx) => Promise<void>) => {
            transactions += 1;
            return run(tx);
        },
    };
    const service = new SanctionService(
        db as never,
        { hmacEmail: (email: string) => `hmac:${email.trim().toLowerCase()}` } as never,
    );

    await service.deleteAccount(7, 'user:7', '탈퇴 요청', auditContext({ source: 'self-service' }));

    assert.equal(transactions, 1);
    const participant = updates.find((entry) => entry.table === schema.matchParticipants)!;
    assert.deepEqual(participant.values, { userId: null });
    const user = updates.find((entry) => entry.table === schema.users)!.values;
    assert.equal(user.accountStatus, 'DELETED');
    assert.match(String(user.email), /^deleted-[0-9a-f]{16}@invalid\.local$/);
    assert.equal(user.passwordHash, '!deleted!');
    assert.match(String(user.nickname), /^Deleted_[0-9a-f]{8}$/);
    assert.deepEqual(user.stats, {});
    assert.equal(user.termsVersion, null);
    assert.equal(user.privacyAgreedAt, null);
    assert.ok(deletes.includes(schema.sessions));
    assert.ok(deletes.includes(schema.mfaSettings));
    assert.ok(deletes.includes(schema.mfaBackupCodes));
    assert.ok(deletes.includes(schema.trustedDevices));
    assert.equal([
        String(user.email),
        String(user.passwordHash),
        String(user.nickname),
        JSON.stringify(audits),
    ].some((value) => value.includes('User@Example.com')), false);
    assert.deepEqual(audits[0]!.requestMeta, { source: 'self-service' });

    const hmacUpdate = dialect.sqlToQuery(statements[0]).sql.replace(/\s+/g, ' ').toLowerCase();
    assert.match(hmacUpdate, /update sanctions sanction set email_hmac/);
    assert.match(hmacUpdate, /sanction\.expires_at > \$\d+::timestamptz/);
    assert.match(hmacUpdate, /sanction\.type = 'ban' and sanction\.expires_at is null/);
    assert.match(hmacUpdate, /not exists \( select 1 from sanction_revocations/);
});

test('2차 인증 설정이 있는 계정은 메일 탈퇴 코드만으로 삭제할 수 없다', async () => {
    let writes = 0;
    const tx = {
        select: () => ({
            from: (table: unknown) => table === schema.mfaSettings
                ? { where: async () => [{ method: 'totp' }] }
                : { where: () => ({ for: async () => [{ status: 'ACTIVE', email: 'user@example.com' }] }) },
        }),
        update: () => { writes += 1; return {} as never; },
        delete: () => { writes += 1; return {} as never; },
        execute: () => { writes += 1; return Promise.resolve([]); },
    };
    const service = new SanctionService(
        { transaction: async (run: (value: typeof tx) => unknown) => run(tx) } as never,
        { hmacEmail: () => 'hmac' } as never,
    );
    await assert.rejects(
        service.deleteAccount(7, 'user:7', 'delete', auditContext()),
        (error: any) => error?.response?.code === 'MFA_REQUIRED',
    );
    assert.equal(writes, 0);
});
