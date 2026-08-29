import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ReportsService } from './reports.service';

const MATCH_ID = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '22222222-2222-4222-8222-222222222222';

const dto = {
    matchId: MATCH_ID,
    targetUserId: 2,
    category: 'CHEAT' as const,
    description: '충분히 긴 신고 설명입니다.',
};

const validContext = {
    endedAt: null,
    replayStatus: null,
    reporterParticipates: true,
    targetUserId: 2,
    targetIsGuest: false,
};

type ScriptItem = unknown[] | Error;

function scriptedDb(transactions: ScriptItem[][]) {
    let transactionIndex = 0;
    const executeCounts: number[] = [];
    return {
        executeCounts,
        transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
            const script = transactions[transactionIndex++] ?? [];
            let executeIndex = 0;
            const tx = {
                execute: async () => {
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
    const service = new ReportsService(db as never);
    await rejectsCode(
        service.create(1, dto),
        ForbiddenException,
        'REPORTER_NOT_MATCH_PARTICIPANT',
    );
});

test('게스트 대상 신고는 400으로 거절한다', async () => {
    const db = scriptedDb([[[{ ...validContext, targetUserId: null, targetIsGuest: true }]]]);
    const service = new ReportsService(db as never);
    await rejectsCode(service.create(1, dto), BadRequestException, 'INVALID_REPORT_TARGET');
});

test('자기 신고는 400으로 거절한다', async () => {
    const db = scriptedDb([[[{ ...validContext, targetUserId: 1 }]]]);
    const service = new ReportsService(db as never);
    await rejectsCode(service.create(1, { ...dto, targetUserId: 1 }), BadRequestException, 'SELF_REPORT');
});

test('리플레이가 남아 있지 않은 경기의 신고는 400으로 거절한다', async () => {
    const endedAt = new Date(Date.now() - 60 * 60 * 1000);
    const db = scriptedDb([[[{ ...validContext, endedAt, replayStatus: 'deleted' }]]]);
    const service = new ReportsService(db as never);
    await rejectsCode(service.create(1, dto), BadRequestException, 'REPLAY_UNAVAILABLE');
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
    const service = new ReportsService(db as never);
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
    const service = new ReportsService(db as never);
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
    const service = new ReportsService(db as never);

    const first = await service.create(1, dto);
    const second = await service.create(3, { ...dto, category: 'ABUSE' });

    assert.deepEqual(first, { caseId: CASE_ID, status: 'OPEN' });
    assert.deepEqual(second, { caseId: CASE_ID, status: 'OPEN' });
    // 두 접수 모두 사건 upsert, 신고 추가, 개수 재계산, hold 추가까지 한 트랜잭션에서 끝난다.
    assert.deepEqual(db.executeCounts, [5, 5]);
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
    const service = new ReportsService(db as never);
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
    const service = new ReportsService(db as never);
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
