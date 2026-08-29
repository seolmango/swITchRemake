#!/usr/bin/env node
/**
 * 브라우저 자동 점검이 남긴 계정을 정리한다.
 *
 *   node scripts/e2e-cleanup.cjs          # 몇 개 남았는지만 본다
 *   node scripts/e2e-cleanup.cjs --apply  # 실제로 정리한다
 *
 * 점검은 흐름마다 끝에서 스스로 탈퇴하지만, 중간에 실패하면 그 계정이 남는다. 쌓여도
 * 새 점검을 막지는 않지만(매번 새 주소를 쓴다) 운영자 화면의 "활성 계정" 숫자를 거짓말로 만든다.
 *
 * **행을 지우지 않는다.** 경기 기록이 `match_participants.user_id`를 가리키고 있어서(onDelete
 * restrict) 지울 수도 없고, 지우면 남의 지난 경기 결과까지 사라진다. 앱의 탈퇴와 똑같이
 * 상태만 DELETED로 바꾸고 세션을 끊는다.
 */
const { resolve } = require('node:path');
const postgres = require('postgres');
require('dotenv').config({ path: resolve(__dirname, '..', '.env'), quiet: true });

const apply = process.argv.includes('--apply');
const sql = postgres({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

(async () => {
    const stale = await sql`
        SELECT id FROM users
        WHERE email LIKE 'e2e-%@example.com' AND account_status = 'ACTIVE'
    `;
    if (stale.length === 0) {
        console.log('정리할 점검 계정이 없습니다.');
        return;
    }
    if (!apply) {
        console.log(`활성 상태로 남은 점검 계정 ${stale.length}개. 정리하려면 --apply를 붙이세요.`);
        return;
    }

    const ids = stale.map((row) => row.id);
    await sql.begin(async (tx) => {
        await tx`UPDATE users SET account_status = 'DELETED', updated_at = now() WHERE id IN ${tx(ids)}`;
        await tx`DELETE FROM sessions WHERE user_id IN ${tx(ids)}`;
        await tx`
            INSERT INTO admin_audit_log (actor, action, target_type, target_id, reason, request_meta)
            SELECT 'script:e2e-cleanup', 'ACCOUNT_DELETED', 'user', id::text, 'E2E leftover cleanup', '{}'::jsonb
            FROM unnest(${sql.array(ids)}::int[]) AS id
        `;
    });
    console.log(`점검 계정 ${ids.length}개를 정리했습니다.`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => sql.end({ timeout: 5 }));
