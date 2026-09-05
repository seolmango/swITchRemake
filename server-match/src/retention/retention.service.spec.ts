import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { retentionSettings } from './retention.settings';
import { RetentionService } from './retention.service';

const dialect = new PgDialect();

const auditTriggerMigration = readFileSync(
    resolve(__dirname, '../../drizzle/0008_admin_audit_append_only.sql'),
    'utf8',
).replace(/\s+/g, ' ').toLowerCase();

function queryText(query: SQL): string {
    return dialect.sqlToQuery(query).sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function harness(options: {
    lock?: boolean;
    liveServers?: string[];
    execute?: (text: string, index: number) => Record<string, unknown>[];
    deleteReplay?: () => Promise<boolean>;
} = {}) {
    const queries: SQL[] = [];
    const replayRequests: Array<{ serverId: string; payload: Record<string, unknown> }> = [];
    let releases = 0;
    const db = {
        execute: async (query: SQL) => {
            const index = queries.push(query) - 1;
            return options.execute?.(queryText(query), index) ?? [];
        },
    };
    const redis = {
        setIfAbsent: async () => options.lock ?? true,
        compareAndDelete: async () => { releases += 1; return true; },
        sortedSetMembers: async () => options.liveServers ?? [],
    };
    const rooms = {
        requestReplayDeletion: async (serverId: string, payload: Record<string, unknown>) => {
            replayRequests.push({ serverId, payload });
            return options.deleteReplay?.() ?? true;
        },
    };
    return {
        service: new RetentionService(db as never, redis as never, rooms as never),
        queries,
        replayRequests,
        releases: () => releases,
    };
}

test('리플레이는 사람별 경기 수와 무관하게 종료 2시간 뒤 삭제 대상으로 표시한다', async () => {
    const state = harness();
    await state.service.runOnce(new Date('2026-08-29T00:00:00Z'));

    const mark = queryText(state.queries[0]);
    assert.doesNotMatch(mark, /row_number|replay_rank/);
    assert.match(mark, /match\.ended_at < \$1::timestamptz/);
    const compiled = dialect.sqlToQuery(state.queries[0]);
    assert.equal(compiled.params[0], '2026-08-28T22:00:00.000Z');
    assert.match(mark, /set status = 'deleting'/);
    assert.match(mark, /limit 200/);
});

test('활성 hold가 걸린 리플레이는 만료 표시에서 건너뛴다', async () => {
    const state = harness({ liveServers: ['game-1'] });
    await state.service.runOnce();

    const mark = queryText(state.queries[0]);
    assert.match(mark, /from replay_holds hold/);
    assert.match(mark, /hold\.replay_id = replay\.id and hold\.released_at is null/);
    const pendingDeletion = queryText(state.queries[1]);
    assert.match(pendingDeletion, /from replay_holds hold/);
    assert.match(pendingDeletion, /hold\.released_at is null/);
});

test('CLOSED가 아닌 사건이 걸린 경기는 30일이 지나도 지우지 않는다', async () => {
    const state = harness();
    await state.service.runOnce();

    const removeMatches = queryText(state.queries[1]);
    assert.match(removeMatches, /from moderation_cases moderation_case/);
    assert.match(removeMatches, /moderation_case\.status <> 'closed'/);
    assert.match(removeMatches, /delete from matches match/);
    assert.match(removeMatches, /limit 200/);
});

test('리더 락을 못 잡으면 DB와 인게임 서버에 아무 일도 하지 않는다', async () => {
    const state = harness({ lock: false, liveServers: ['game-1'] });
    await state.service.runOnce();

    assert.equal(state.queries.length, 0);
    assert.equal(state.replayRequests.length, 0);
    assert.equal(state.releases(), 0);
});

test('DELETE_REPLAY가 실패하면 deleting 행을 지우지 않는다', async () => {
    const state = harness({
        liveServers: ['fallback'],
        deleteReplay: async () => false,
        execute: (_text, index) => index === 1
            ? [{ replayId: 'replay-1', storageKey: 'replays/one.rpl', serverId: 'dead-server' }]
            : [],
    });
    await state.service.runOnce();

    assert.deepEqual(state.replayRequests, [{
        serverId: 'fallback',
        payload: { replayId: 'replay-1', storageKey: 'replays/one.rpl' },
    }]);
    assert.equal(state.queries.some((query) => /^delete from replays /.test(queryText(query))), false);
    assert.equal(state.releases(), 1);
});

test('보관 설정 파싱은 잘못된 env를 부팅 전에 거절한다', () => {
    for (const [name, value] of [
        ['MATCH_RETENTION_DAYS', '0'],
        ['REPLAY_RETENTION_HOURS', '-1'],
        ['RETENTION_INTERVAL_MINUTES', 'ten'],
        ['AUDIT_LOG_RETENTION_DAYS', '0'],
        ['AUDIT_IP_RETENTION_DAYS', '1.5'],
    ]) {
        assert.throws(
            () => retentionSettings({ [name]: value }),
            /보관 설정은 양의 정수여야 한다/,
        );
    }
});

test('삭제가 연달아 실패하면 그 회차를 접는다', async () => {
    /*
     * 실패는 대개 한 건짜리 사고가 아니라 상태다. 남은 행을 계속 두드리면 요청 하나마다 명령
     * 시한을 꽉 채워 기다리고, 그 시간 동안 방 생성 같은 진짜 명령이 같은 줄에 선다.
     */
    const rows = Array.from({ length: 10 }, (_value, index) => ({
        replayId: `replay-${index}`,
        storageKey: `replays/${index}.rpl`,
        serverId: 'dead-server',
    }));
    const state = harness({
        liveServers: ['fallback'],
        deleteReplay: async () => false,
        execute: (_text, index) => index === 1 ? rows : [],
    });
    await state.service.runOnce();

    assert.equal(state.replayRequests.length, 3, '세 번 연속 실패하면 나머지는 다음 회차로 미룬다');
});

test('끝난 세션 행을 보관 기간이 지난 뒤에 지운다', async () => {
    const state = harness();
    await state.service.runOnce(new Date('2026-08-29T00:00:00Z'));

    const sessions = state.queries.map(queryText).find((query) => query.includes('delete from sessions'))!;
    assert.match(sessions, /delete from sessions/);
    // 살아 있는 세션은 건드리지 않는다 - 끝났고, 그러고도 보관 기간이 지난 것만이다.
    assert.match(sessions, /session\.revoked_at is not null or session\.expires_at < \$\d+/);
    assert.match(sessions, /coalesce\(session\.revoked_at, session\.expires_at\) < \$\d+::timestamptz/);
    assert.match(sessions, /for update of session skip locked/);
});

test('감사 IP 원본은 7일 뒤 비우고 감사 로그는 365일 뒤 삭제한다', async () => {
    const state = harness();
    await state.service.runOnce(new Date('2026-08-29T00:00:00Z'));
    const queries = state.queries.map(queryText);
    const scrub = queries.find((query) => query.includes('update admin_audit_log audit'))!;
    const remove = queries.find((query) => query.includes('delete from admin_audit_log audit'))!;
    assert.match(scrub, /audit\.ip_encrypted is not null/);
    assert.match(scrub, /set ip_encrypted = null/);
    assert.match(scrub, /set_config\('switch\.audit_retention', 'on', true\)/);
    assert.match(remove, /set_config\('switch\.audit_retention', 'on', true\)/);
    assert.equal(dialect.sqlToQuery(state.queries[queries.indexOf(scrub)]).params.at(-1), '2026-08-22T00:00:00.000Z');
    assert.equal(dialect.sqlToQuery(state.queries[queries.indexOf(remove)]).params.at(-1), '2025-08-29T00:00:00.000Z');
});

test('끝난 기간제·취소 제재의 이메일 HMAC만 지우고 영구 BAN은 남긴다', async () => {
    const state = harness();
    await state.service.runOnce();
    const cleanup = state.queries.map(queryText)
        .find((query) => query.includes('update sanctions sanction set email_hmac = null'))!;
    assert.match(cleanup, /sanction\.expires_at <= \$\d+::timestamptz/);
    assert.match(cleanup, /sanction\.expires_at is null and sanction\.type <> 'ban'/);
    assert.match(cleanup, /from sanction_revocations revocation/);
});

test('audit migration attaches the append-only trigger with only retention exceptions', () => {
    assert.match(auditTriggerMigration, /create or replace function "prevent_admin_audit_log_mutation"/);
    assert.match(auditTriggerMigration, /drop trigger if exists "admin_audit_log_append_only" on "admin_audit_log"/);
    assert.match(auditTriggerMigration, /create trigger "admin_audit_log_append_only" before update or delete on "admin_audit_log"/);
    assert.match(auditTriggerMigration, /current_setting\('switch\.audit_retention', true\) = 'on'/);
    assert.match(auditTriggerMigration, /if tg_op = 'delete' then return old/);
    assert.match(auditTriggerMigration, /if tg_op = 'update'.*old\.ip_encrypted is not null.*new\.ip_encrypted is null.*raise exception 'admin_audit_log is append only'/);
});
