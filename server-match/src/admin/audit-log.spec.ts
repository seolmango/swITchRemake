import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../database/schema';
import { auditContext, auditContextWithIp } from './audit-log';

test('감사 부가 정보는 평문 IP 키와 IP처럼 보이는 값을 받지 않는다', () => {
    assert.throws(() => auditContext({ ip: '203.0.113.7' } as never), /전용 보호 컬럼/);
    assert.throws(() => auditContext({ query: '203.0.113.7' }), /평문 IP/);
    assert.deepEqual(auditContext({ caseId: 'case-1' }).requestMeta, { caseId: 'case-1' });
});

test('감사 IP는 세션 보안 서비스의 HMAC과 암호화본으로만 나온다', () => {
    const seen: string[] = [];
    const context = auditContextWithIp({
        protectIp: (ip: string) => {
            seen.push(ip);
            return { ipHmac: 'a'.repeat(64), ipEncrypted: 'v1:ciphertext' };
        },
    } as never, '203.0.113.7', { source: 'account-delete' });
    assert.deepEqual(seen, ['203.0.113.7']);
    assert.deepEqual(context, {
        requestMeta: { source: 'account-delete' },
        ipHmac: 'a'.repeat(64),
        ipEncrypted: 'v1:ciphertext',
    });
});

test('DB 스키마도 request_meta의 IP 키를 거절한다', () => {
    const checks = getTableConfig(schema.adminAuditLog).checks.map((check) => check.name);
    assert.ok(checks.includes('admin_audit_log_request_meta_no_ip'));
    assert.ok(checks.includes('admin_audit_log_ip_hmac_format'));
});
