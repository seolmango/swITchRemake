import assert from 'node:assert/strict';
import test from 'node:test';
import { MATCH_RESULT_VERSION, type MatchResultMessage } from 'shared';
import { ResultService } from './result.service';

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

test('다음 경기는 매칭 서버가 만들고, 배정은 방금 끝난 경기에서 옮겨 붙는다', async () => {
    const assignments = [
        { matchId: result.matchId, actorId: '1', userId: 1, nickname: 'A', isGuest: false },
        { matchId: result.matchId, actorId: 'g:x', userId: null, nickname: 'Guest_7KPW2M', isGuest: true },
    ];
    const insertedMatches: Record<string, unknown>[] = [];
    const insertedAssignments: Record<string, unknown>[] = [];
    let table = 0;
    const tx = {
        select: () => ({ from: () => ({ where: async () => assignments }) }),
        insert: () => {
            table += 1;
            const target = table === 1 ? insertedMatches : insertedAssignments;
            return {
                values: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
                    target.push(...(Array.isArray(rows) ? rows : [rows]));
                    return { returning: async () => [{ matchId: target[0]?.['matchId'] }] };
                },
            };
        },
    };
    const db = { transaction: async (run: (value: typeof tx) => unknown) => run(tx) };
    const service = new ResultService(db as never);

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
    const tx = {
        select: () => ({ from: () => ({ where: async () => [] }) }),
        insert: () => ({ values: () => { throw new Error('발급하면 안 된다'); } }),
    };
    const db = { transaction: async (run: (value: typeof tx) => unknown) => run(tx) };
    const service = new ResultService(db as never);
    assert.equal(await service.issueNextMatch(result), null);
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

test('records exactly one winner in participant rows', async () => {
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
    const tx = {
        select: () => {
            const call = selectCount++;
            if (call === 0) {
                return { from: () => ({ where: () => ({ for: async () => [{
                    matchId: singleWinner.matchId,
                    roomId: singleWinner.roomId,
                    serverId: singleWinner.serverId,
                    mapId: singleWinner.mapId,
                    resultRecordedAt: null,
                }] }) }) };
            }
            return { from: () => ({ where: async () => assignments }) };
        },
        update: () => ({
            set: () => ({
                where: () => ({ returning: async () => [{ matchId: singleWinner.matchId }] }),
            }),
        }),
        insert: () => ({
            values: async (rows: Array<Record<string, unknown>>) => { participantRows = rows; },
        }),
    };
    const db = { transaction: async (run: (value: typeof tx) => unknown) => run(tx) };
    const service = new ResultService(db as never);

    assert.equal(await service.record(singleWinner), 'stored');
    assert.deepEqual(
        participantRows.map((player) => ({ playerId: player['playerId'], isWinner: player['isWinner'] })),
        [{ playerId: 1, isWinner: true }, { playerId: 2, isWinner: false }],
    );
});
