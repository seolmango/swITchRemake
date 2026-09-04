import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ReportsService } from './reports.service';

/** 제재를 부르지 않아야 하는 흐름들이 쓴다. 부르면 그 사실이 바로 드러난다. */
const noSanctions = { apply: () => { throw new Error('이 흐름은 제재를 부르면 안 된다'); } };
const noRooms = { evictActor: () => { throw new Error('이 흐름은 퇴장을 부르면 안 된다'); } };

const MATCH_ID = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '22222222-2222-4222-8222-222222222222';
const SANCTION_ID = '33333333-3333-4333-8333-333333333333';

const dto = {
    matchId: MATCH_ID,
    targetPlayerId: 2,
    category: 'CHEAT' as const,
    description: '충분히 긴 신고 설명입니다.',
};

const validContext = {
    endedAt: null,
    replayStatus: null,
    reporterParticipates: true,
    reporterPlayerId: 1,
    targetUserId: 2,
    targetPlayerId: 2,
    targetNickname: '대상계정',
    targetIsGuest: false,
};

type ScriptItem = unknown[] | Error;

function scriptedDb(transactions: ScriptItem[][]) {
    let transactionIndex = 0;
    const executeCounts: number[] = [];
    const queries: unknown[][] = [];
    return {
        executeCounts,
        queries,
        transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
            const script = transactions[transactionIndex++] ?? [];
            let executeIndex = 0;
            queries[transactionIndex - 1] = [];
            const tx = {
                execute: async (query: unknown) => {
                    queries[transactionIndex - 1].push(query);
                    executeCounts[transactionIndex - 1] = executeIndex + 1;
                    const result = script[executeIndex++];
                    if (result instanceof Error) throw result;
                    return result ?? [];
                },
            };
            return callback(tx);
        },
    };
}

async function rejectsCode(
    promise: Promise<unknown>,
    exception: typeof BadRequestException | typeof ConflictException | typeof ForbiddenException,
    code: string,
) {
    await assert.rejects(promise, (error: unknown) => {
        if (!(error instanceof exception)) return false;
        return (error.getResponse() as { code?: string }).code === code;
    });
}

test('경기 참가자가 아닌 신고자는 403으로 거절한다', async () => {
    const db = scriptedDb([[[{ ...validContext, reporterParticipates: false }]]]);
    const service = new ReportsService(db as never, noSanctions as never, noRooms as never);
    await rejectsCode(
        service.create(1, dto),
        ForbiddenException,
        'REPORTER_NOT_MATCH_PARTICIPANT',
    );
});

test('게스트 대상 신고가 사건을 만들고 경기 당시 닉네임을 박는다', async () => {
    const db = scriptedDb([[
        [{
            ...validContext,
            targetUserId: null,
            targetPlayerId: 7,
            targetNickname: '방문자칠',
            targetIsGuest: true,
        }],
        [{ caseId: CASE_ID, status: 'OPEN' }],
        [],
        [{ caseId: CASE_ID, status: 'OPEN' }],
        [],
    ]]);
    const service = new ReportsService(db as never, noSanctions as never, noRooms as never);
    const result = await service.create(1, { ...dto, targetPlayerId: 7 });

    assert.deepEqual(result, { caseId: CASE_ID, status: 'OPEN' });
    assert.match(JSON.stringify(db.queries[0][1]), /방문자칠/);
});

test('자기 신고는 400으로 거절한다', async () => {
    const db = scriptedDb([[[{ ...validContext, targetUserId: 1, targetPlayerId: 1 }]]]);
    const service = new ReportsService(db as never, noSanctions as never, noRooms as never);
    await rejectsCode(service.create(1, { ...dto, targetPlayerId: 1 }), BadRequestException, 'SELF_REPORT');
});

test('리플레이가 남아 있지 않은 경기의 신고는 400으로 거절한다', async () => {
    const endedAt = new Date(Date.now() - 60 * 60 * 1000);
    const db = scriptedDb([[[{ ...validContext, endedAt, replayStatus: 'deleted' }]]]);
    const service = new ReportsService(db as never, noSanctions as never, noRooms as never);
    await rejectsCode(service.create(1, dto), BadRequestException, 'REPLAY_UNAVAILABLE');
});

test('리플레이 기록이 없는 경기는 보관 기간 안에서만 신고할 수 있다', async () => {
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const db = scriptedDb([[[{ ...validContext, endedAt: stale, replayStatus: null }]]]);
    const service = new ReportsService(db as never, noSanctions as never, noRooms as never);
    await rejectsCode(service.create(1, dto), BadRequestException, 'REPORT_WINDOW_EXPIRED');
});

test('방금 끝난 경기는 리플레이 행이 없어도 신고할 수 있다', async () => {
    const db = scriptedDb([[
        [{ ...validContext, endedAt: new Date(), replayStatus: null }],
        [{ caseId: CASE_ID, status: 'OPEN' }],
        [],
        [{ caseId: CASE_ID, status: 'OPEN' }],
        [],
    ]]);
    const service = new ReportsService(db as never, noSanctions as never, noRooms as never);
    assert.deepEqual(await service.create(1, dto), { caseId: CASE_ID, status: 'OPEN' });
});

test('리플레이가 살아 있으면 끝난 경기도 신고할 수 있다', async () => {
    const endedAt = new Date(Date.now() - 60 * 60 * 1000);
    const db = scriptedDb([[
        [{ ...validContext, endedAt, replayStatus: 'available' }],
        [{ caseId: CASE_ID, status: 'OPEN' }],
        [],
        [{ caseId: CASE_ID, status: 'OPEN' }],
        [],
    ]]);
    const service = new ReportsService(db as never, noSanctions as never, noRooms as never);
    assert.deepEqual(await service.create(1, dto), { caseId: CASE_ID, status: 'OPEN' });
});

test('같은 신고자의 중복 신고는 409로 거절한다', async () => {
    const duplicate = Object.assign(new Error('duplicate'), {
        code: '23505',
        constraint_name: 'reports_case_id_reporter_user_id_unique',
    });
    const db = scriptedDb([[
        [validContext],
        [{ caseId: CASE_ID, status: 'OPEN' }],
        duplicate,
    ]]);
    const service = new ReportsService(db as never, noSanctions as never, noRooms as never);
    await rejectsCode(service.create(1, dto), ConflictException, 'DUPLICATE_REPORT');
});

test('정상 신고는 사건을 만들고 두 번째 신고자는 같은 사건에 붙는다', async () => {
    const successfulTransaction: ScriptItem[] = [
        [validContext],
        [{ caseId: CASE_ID, status: 'OPEN' }],
        [],
        [{ caseId: CASE_ID, status: 'OPEN' }],
        [],
    ];
    const db = scriptedDb([successfulTransaction, successfulTransaction]);
    const service = new ReportsService(db as never, noSanctions as never, noRooms as never);

    const first = await service.create(1, dto);
    const second = await service.create(3, { ...dto, category: 'ABUSE' });

    assert.deepEqual(first, { caseId: CASE_ID, status: 'OPEN' });
    assert.deepEqual(second, { caseId: CASE_ID, status: 'OPEN' });
    // 두 접수 모두 사건 upsert, 신고 추가, 개수 재계산, hold 추가까지 한 트랜잭션에서 끝난다.
    assert.deepEqual(db.executeCounts, [5, 5]);
});

function sanctionHarness(caseRow: Record<string, unknown>) {
    const updates: Record<string, unknown>[] = [];
    const audits: Record<string, unknown>[] = [];
    const applyInputs: Record<string, unknown>[] = [];
    const evictions: { userId: number | string; reason: string }[] = [];
    return {
        updates,
        audits,
        applyInputs,
        evictions,
        rooms: {
            evictActor: async (userId: number | string, reason: string) => {
                evictions.push({ userId, reason });
                return true;
            },
        },
        db: {
            transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
                execute: async () => [caseRow],
                update: () => ({
                    set: (value: Record<string, unknown>) => {
                        updates.push(value);
                        return { where: async () => [] };
                    },
                }),
                insert: () => ({
                    values: async (value: Record<string, unknown>) => {
                        audits.push(value);
                        return [];
                    },
                }),
            }),
        },
        sanctions: {
            apply: async (input: Record<string, unknown>) => {
                applyInputs.push(input);
                return { id: SANCTION_ID };
            },
        },
    };
}

test('게스트 사건에 제재를 걸면 400으로 거절한다', async () => {
    const harness = sanctionHarness({
        caseId: CASE_ID,
        matchId: MATCH_ID,
        targetUserId: null,
        status: 'OPEN',
    });
    const service = new ReportsService(harness.db as never, harness.sanctions as never, harness.rooms as never);

    await rejectsCode(
        service.sanction(CASE_ID, 9, { type: 'BAN', reason: '게스트 사건 제재 사유입니다' }),
        BadRequestException,
        'GUEST_TARGET_NOT_SANCTIONABLE',
    );
    assert.equal(harness.applyInputs.length, 0);
});

test('계정 사건에 BAN을 걸면 경기 근거로 제재하고 사건을 ACTIONED로 옮긴다', async () => {
    const harness = sanctionHarness({
        caseId: CASE_ID,
        matchId: MATCH_ID,
        targetUserId: 2,
        status: 'TRIAGED',
    });
    const service = new ReportsService(harness.db as never, harness.sanctions as never, harness.rooms as never);

    const result = await service.sanction(CASE_ID, 9, {
        type: 'BAN',
        days: 30,
        reason: '반복적인 부정행위가 확인되었습니다',
    });

    assert.deepEqual(result, { caseId: CASE_ID, status: 'ACTIONED', sanctionId: SANCTION_ID });
    // 세션만 지우면 이미 발급된 토큰으로 그 경기를 끝까지 뛴다. 방에서도 내보내야 한다.
    assert.deepEqual(harness.evictions, [{ userId: 2, reason: 'sanction:BAN' }]);
    assert.equal(harness.applyInputs.length, 1);
    assert.deepEqual(
        {
            userId: harness.applyInputs[0].userId,
            type: harness.applyInputs[0].type,
            scope: harness.applyInputs[0].scope,
            evidenceMatchId: harness.applyInputs[0].evidenceMatchId,
            actor: harness.applyInputs[0].actor,
            requestMeta: harness.applyInputs[0].requestMeta,
        },
        {
            userId: 2,
            type: 'BAN',
            scope: 'account',
            evidenceMatchId: MATCH_ID,
            actor: 'admin:9',
            requestMeta: { caseId: CASE_ID },
        },
    );
    assert.equal(harness.updates[0].status, 'ACTIONED');
    assert.equal(harness.audits[0].action, 'report.sanction');
});

test('경고는 방에서 내보내지 않는다', async () => {
    const harness = sanctionHarness({
        caseId: CASE_ID,
        matchId: MATCH_ID,
        targetUserId: 2,
        status: 'TRIAGED',
    });
    const service = new ReportsService(harness.db as never, harness.sanctions as never, harness.rooms as never);

    await service.sanction(CASE_ID, 9, { type: 'WARN', reason: '경고 사유를 충분히 적었습니다' });

    // 경고는 계속 놀 수 있다는 뜻이다. 여기서 내보내면 사실상 밴이 된다.
    assert.deepEqual(harness.evictions, []);
});

test('CLOSED 사건에 제재를 걸면 409로 거절한다', async () => {
    const harness = sanctionHarness({
        caseId: CASE_ID,
        matchId: MATCH_ID,
        targetUserId: 2,
        status: 'CLOSED',
    });
    const service = new ReportsService(harness.db as never, harness.sanctions as never, harness.rooms as never);

    await rejectsCode(
        service.sanction(CASE_ID, 9, { type: 'WARN', reason: '종결 사건에는 제재할 수 없습니다' }),
        ConflictException,
        'REPORT_CASE_CLOSED',
    );
    assert.equal(harness.applyInputs.length, 0);
});

test('이미 ACTIONED인 사건에 제재를 다시 걸지 않는다', async () => {
    const harness = sanctionHarness({
        caseId: CASE_ID,
        matchId: MATCH_ID,
        targetUserId: 2,
        status: 'ACTIONED',
    });
    const service = new ReportsService(harness.db as never, harness.sanctions as never, harness.rooms as never);

    await rejectsCode(
        service.sanction(CASE_ID, 9, { type: 'BAN', reason: '중복 요청으로 다시 들어온 제재입니다' }),
        ConflictException,
        'REPORT_CASE_ALREADY_ACTIONED',
    );
    assert.equal(harness.applyInputs.length, 0);
    assert.deepEqual(harness.evictions, []);
});

function statusDb(currentStatus: string) {
    const updates: Record<string, unknown>[] = [];
    const audits: Record<string, unknown>[] = [];
    return {
        updates,
        audits,
        transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
            execute: async () => [{ status: currentStatus }],
            update: () => ({
                set: (value: Record<string, unknown>) => {
                    updates.push(value);
                    return { where: async () => [] };
                },
            }),
            insert: () => ({
                values: async (value: Record<string, unknown>) => {
                    audits.push(value);
                    return [];
                },
            }),
        }),
    };
}

test('허용되지 않은 신고 상태 전이는 409로 거절한다', async () => {
    const db = statusDb('OPEN');
    const service = new ReportsService(db as never, noSanctions as never, noRooms as never);
    await rejectsCode(
        service.updateStatus(CASE_ID, 9, { status: 'ACTIONED' }),
        ConflictException,
        'INVALID_REPORT_STATUS_TRANSITION',
    );
    assert.equal(db.updates.length, 0);
    assert.equal(db.audits.length, 0);
});

test('신고 상태 변경은 관리자 감사 로그를 남긴다', async () => {
    const db = statusDb('OPEN');
    const service = new ReportsService(db as never, noSanctions as never, noRooms as never);
    const result = await service.updateStatus(CASE_ID, 9, { status: 'TRIAGED', note: '초기 분류 완료' });

    assert.deepEqual(result, { caseId: CASE_ID, status: 'TRIAGED' });
    assert.equal(db.updates.length, 1);
    assert.deepEqual(db.audits, [{
        actor: '9',
        action: 'report.status',
        targetType: 'moderation_case',
        targetId: CASE_ID,
        reason: '초기 분류 완료',
        requestMeta: { previousStatus: 'OPEN', nextStatus: 'TRIAGED' },
    }]);
});
