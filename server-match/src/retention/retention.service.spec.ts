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
    // 자를 시각은 JS에서 정해 값 하나로 넘긴다. SQL 안에서 계산하면 드라이버가 Date를
    // 실어 보내다 죽고(ERR_INVALID_ARG_TYPE), 정리 작업은 그 예외를 삼켜 조용히 멈춘다.
    assert.ok(mark.includes("match.ended_at >= $1::timestamptz"), '자를 시각은 값 하나로 넘어가야 한다');
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
