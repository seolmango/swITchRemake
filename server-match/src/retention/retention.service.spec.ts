import assert from 'node:assert/strict';
import test from 'node:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { retentionSettings } from './retention.settings';
import { RetentionService } from './retention.service';

const dialect = new PgDialect();

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

test('참가자 한 명이라도 보관 중이면 제외하고 아무도 들고 있지 않을 때만 표시한다', async () => {
    const state = harness();
    await state.service.runOnce(new Date('2026-08-29T00:00:00Z'));

    const mark = queryText(state.queries[0]);
    assert.match(mark, /row_number\(\) over \( partition by participant\.user_id/);
    assert.match(mark, /participant\.user_id is not null/);
    assert.match(mark, /and not exists \( select 1 from ranked_user_matches retained/);
    // 파라미터 자리 번호($1, $2…)는 쿼리를 고칠 때마다 밀린다. 번호가 아니라 모양을 본다.
    assert.match(mark, /retained\.replay_rank <= \$\d+/);
    assert.match(mark, /match\.ended_at >= \$\d+ - \$\d+ \* interval '1 day'/);
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
        ['REPLAY_RETENTION_DAYS', '-1'],
        ['REPLAY_RETENTION_MAX_MATCHES', '1.5'],
        ['RETENTION_INTERVAL_MINUTES', 'ten'],
    ]) {
        assert.throws(
            () => retentionSettings({ [name]: value }),
            /보관 설정은 양의 정수여야 한다/,
        );
    }
});
