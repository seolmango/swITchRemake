import assert from 'node:assert/strict';
import test from 'node:test';
import { MATCH_RESULT_VERSION, type MatchResultMessage } from 'shared';
import { nextMatchId, ResultService } from './result.service';
import * as schema from '../database/schema';

const result: MatchResultMessage = {
    v: MATCH_RESULT_VERSION,
    matchId: '11111111-1111-4111-8111-111111111111', roomId: 'room', serverId: 'server', mapId: 'map',
    startedAt: 1, endedAt: 2, durationTicks: 1, buildId: 'build', protocolVersion: 1,
    rulesVersion: 'rules', mapBundleHash: 'hash', visibilityCoreVersion: 1,
    winnerPlayerIds: [1, 2], replay: null,
    players: [{
        userId: 1, playerId: 1, nickname: 'A', colorIndex: 0, isGuest: false,
        tagCount: 0, taggedCount: 0, switchTry: 0, switchSuccess: 0, survivedMs: 1,
    }, {
        userId: null, playerId: 2, nickname: 'Guest_7KPW2M', colorIndex: 1, isGuest: true,
        tagCount: 0, taggedCount: 0, switchTry: 0, switchSuccess: 0, survivedMs: 1,
    }],
};

function nextMatchHarness(emptyAssignments = false) {
    const assignments = emptyAssignments ? [] : [
        { matchId: result.matchId, actorId: '1', userId: 1, nickname: 'A', isGuest: false },
        { matchId: result.matchId, actorId: 'g:x', userId: null, nickname: 'Guest_7KPW2M', isGuest: true },
    ];
    const insertedMatches: Record<string, unknown>[] = [];
    const insertedAssignments: Record<string, unknown>[] = [];
    let next: Record<string, unknown> | undefined;
    const source: Record<string, unknown> = { ...result, resultRecordedAt: new Date(2) };
    const tx = {
        select: () => ({ from: (table: unknown) => ({ where: () => table === schema.matchAssignments
            ? Promise.resolve(assignments)
            : Object.assign(Promise.resolve(next ? [next] : []), { for: async () => [source] }) }) }),
        insert: (table: unknown) => {
            const target = table === schema.matches ? insertedMatches : insertedAssignments;
            return {
                values: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
                    target.push(...(Array.isArray(rows) ? rows : [rows]));
                    if (table === schema.matches) next = { ...rows, resultRecordedAt: null };
                    const returning = { returning: async () => [{ matchId: target[0]?.['matchId'] }] };
                    return { ...returning, onConflictDoNothing: () => returning };
                },
            };
        },
    };
    const db = { transaction: async (run: (value: typeof tx) => unknown) => run(tx) };
    const service = new ResultService(db as never);
    return { service, insertedMatches, insertedAssignments, source, markNextStored: () => { if (next) next['resultRecordedAt'] = new Date(3); } };
}

test('다음 경기는 매칭 서버가 만들고, 배정은 방금 끝난 경기에서 옮겨 붙는다', async () => {
    const { service, insertedMatches, insertedAssignments } = nextMatchHarness();
    const next = await service.issueNextMatch(result);
    assert.ok(next, '다음 경기 id가 나와야 한다');
    assert.notEqual(next, result.matchId, '끝난 경기의 id를 재사용하지 않는다');
    assert.equal(insertedMatches[0]?.['serverId'], result.serverId);
    assert.equal(insertedMatches[0]?.['roomId'], result.roomId);
    // 다음 경기의 참가자 검사가 같은 명단을 봐야 하므로 배정을 그대로 옮긴다.
    assert.deepEqual(insertedAssignments.map((row) => row['actorId']), ['1', 'g:x']);
    assert.ok(insertedAssignments.every((row) => row['matchId'] === next));
});

test('배정이 남아 있지 않은 경기는 다음 경기를 발급하지 않는다', async () => {
    const { service, insertedMatches } = nextMatchHarness(true);
    assert.equal(await service.issueNextMatch(result), null);
    assert.equal(insertedMatches.length, 0);
});

test('다음 경기 전달 재시도는 동일 발급을 재사용하고 참가자 배정을 중복하지 않는다', async () => {
    const { service, insertedMatches, insertedAssignments, markNextStored } = nextMatchHarness();
    const first = await service.issueNextMatch(result);
    assert.equal(await service.issueNextMatch(result), first);
    assert.equal(first, nextMatchId(result.matchId));
    assert.equal(insertedMatches.length, 1);
    assert.equal(insertedAssignments.length, 2);
    markNextStored();
    assert.equal(await service.issueNextMatch(result), null, 'a previously consumed grant must not replace a later match');
});

test('retry identity remains a protocol UUID and normalizes PostgreSQL UUID case', () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const next = nextMatchId(id);
    assert.match(next, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(nextMatchId(id.toUpperCase()), next);
    assert.notEqual(nextMatchId(next), next);
});

test('다음 경기 발급은 완료된 source의 방/서버 권한을 다시 확인한다', async () => {
    const { service, source, insertedMatches } = nextMatchHarness();
    assert.equal(await service.issueNextMatch({ ...result, roomId: 'other-room' }), null);
    assert.equal(await service.issueNextMatch({ ...result, serverId: 'other-server' }), null);
    source['resultRecordedAt'] = null;
    assert.equal(await service.issueNextMatch(result), null);
    assert.equal(insertedMatches.length, 0);
});

test('같은 room/server의 과거 경기가 있어도 선발급되지 않은 matchId 결과는 만들지 않는다', async () => {
    let inserted = false;
    const tx = {
        select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
        insert: () => ({ values: async () => { inserted = true; } }),
    };
    const db = { transaction: async (run: (value: typeof tx) => unknown) => run(tx) };
    const service = new ResultService(db as never);
    assert.equal(await service.record(result), 'invalid');
    assert.equal(inserted, false);
});

for (const initialMap of ['map', 'previous-lobby-map']) test(`records winner and played map after assignment on ${initialMap}`, async () => {
    const singleWinner = structuredClone(result);
    singleWinner.winnerPlayerIds = [1];
    singleWinner.players = singleWinner.players.map((player, index) => ({
        ...player,
        userId: null,
        isGuest: true,
        nickname: `Guest_${index + 1}`,
    }));
    const assignments = singleWinner.players.map((player, index) => ({
        matchId: singleWinner.matchId,
        actorId: `g:${index}`,
        userId: null,
        nickname: player.nickname,
        isGuest: true,
    }));
    let selectCount = 0;
    let participantRows: Array<Record<string, unknown>> = [];
    let storedMatch: Record<string, unknown> = {};
    const tx = {
        select: () => {
            const call = selectCount++;
            if (call === 0) {
                return { from: () => ({ where: () => ({ for: async () => [{
                    matchId: singleWinner.matchId,
                    roomId: singleWinner.roomId,
                    serverId: singleWinner.serverId,
                    mapId: initialMap,
                    resultRecordedAt: null,
                }] }) }) };
            }
            return { from: () => ({ where: async () => assignments }) };
        },
        update: () => ({
            set: (values: Record<string, unknown>) => {
                storedMatch = values;
                return { where: () => ({ returning: async () => [{ matchId: singleWinner.matchId }] }) };
            },
        }),
        insert: () => ({
            values: async (rows: Array<Record<string, unknown>>) => { participantRows = rows; },
        }),
    };
    const db = { transaction: async (run: (value: typeof tx) => unknown) => run(tx) };
    const service = new ResultService(db as never);

    assert.equal(await service.record(singleWinner), 'stored');
    assert.equal(storedMatch['mapId'], singleWinner.mapId);
    assert.deepEqual(
        participantRows.map((player) => ({ playerId: player['playerId'], isWinner: player['isWinner'] })),
        [{ playerId: 1, isWinner: true }, { playerId: 2, isWinner: false }],
    );
});

for (const mismatch of [{ roomId: 'another-room' }, { serverId: 'another-server' }]) {
    test('a map change never bypasses room/server authorization ' + JSON.stringify(mismatch), async () => {
        const tx = {
            select: () => ({ from: () => ({ where: () => ({ for: async () => [{ ...result, ...mismatch, mapId: 'old-map', resultRecordedAt: null }] }) }) }),
            update: () => { throw new Error('unauthorized result must not be written'); },
        };
        const service = new ResultService({ transaction: async (run: (value: typeof tx) => unknown) => run(tx) } as never);
        assert.equal(await service.record(result), 'invalid');
    });
}
