#!/usr/bin/env node
/**
 * 계정에 운영자 권한을 주거나 뺀다.
 *
 *   node scripts/grant-admin.cjs someone@example.com
 *   node scripts/grant-admin.cjs someone@example.com --revoke
 *
 * 운영자 페이지 안에 "관리자 임명" 버튼을 두지 않는 이유는, 첫 관리자를 만들 방법이 없기 때문이다.
 * 그리고 권한 승격은 DB에 닿을 수 있는 사람만 할 수 있는 편이 안전하다.
 */
const { resolve } = require('node:path');
const postgres = require('postgres');
require('dotenv').config({ path: resolve(__dirname, '..', '.env') });

const email = process.argv[2];
const revoke = process.argv.includes('--revoke');

if (!email || email.startsWith('--')) {
  console.error('사용법: node scripts/grant-admin.cjs <email> [--revoke]');
  process.exit(1);
}

const sql = postgres({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const role = revoke ? 'USER' : 'ADMIN';

(async () => {
  const rows = await sql`
    UPDATE users SET role = ${role}, updated_at = now()
    WHERE email = ${email} AND account_status = 'ACTIVE'
    RETURNING id, nickname, role
  `;
  if (rows.length === 0) {
    console.error(`활성 계정을 찾지 못했습니다: ${email}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${rows[0].nickname}(#${rows[0].id}) -> ${rows[0].role}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => sql.end({ timeout: 5 }));
