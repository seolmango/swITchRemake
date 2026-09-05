import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
    resolve(__dirname, '../../drizzle/0009_two_factor_authentication.sql'),
    'utf8',
);

test('2차 인증 마이그레이션은 비밀·백업 코드·신뢰 기기를 계정 종속 테이블과 제약으로 만든다', () => {
    assert.match(migration, /CREATE TABLE "mfa_settings"/);
    assert.match(migration, /"totp_secret_encrypted" text/);
    assert.match(migration, /"totp_secret_encrypted" LIKE 'v1:%'/);
    assert.match(migration, /"last_totp_step" IS NOT NULL/);
    assert.match(migration, /CREATE TABLE "mfa_backup_codes"/);
    assert.match(migration, /"code_hash" text NOT NULL/);
    assert.match(migration, /CREATE TABLE "trusted_devices"/);
    assert.match(migration, /"token_hash" varchar\(64\) NOT NULL/);
    assert.match(migration, /"expires_at" > "created_at"/);
    assert.equal((migration.match(/ON DELETE cascade/g) ?? []).length, 3);
    assert.equal(/browser|fingerprint|user_agent/i.test(migration), false);
});
