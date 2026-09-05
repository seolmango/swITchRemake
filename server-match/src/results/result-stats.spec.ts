import assert from 'node:assert/strict';
import test from 'node:test';
import { MATCH_RESULT_VERSION, type MatchResultMessage } from 'shared';
import { accountStatsDeltas, linkedParticipantUserId } from './result.service';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../database/schema';

test('계정 누적치에는 생존시간·게임 수·XP를 더하고 게스트와 레벨은 넣지 않는다', () => {
    const result: MatchResultMessage = {
        v: MATCH_RESULT_VERSION,
        matchId: '11111111-1111-4111-8111-111111111111', roomId: 'room', serverId: 'server', mapId: 'map',
        startedAt: 1, endedAt: 2, durationTicks: 1, buildId: 'build', protocolVersion: 1,
        rulesVersion: 'rules', mapBundleHash: 'hash', visibilityCoreVersion: 1,
        winnerPlayerIds: [1, 2], replay: null,
        players: [{
            userId: 7, playerId: 1, nickname: 'Account', colorIndex: 0, isGuest: false,
            tagCount: 3, taggedCount: 1, switchTry: 4, switchSuccess: 2, survivedMs: 90_000,
        }, {
            userId: null, playerId: 2, nickname: 'Guest_7KPW2M', colorIndex: 1, isGuest: true,
            tagCount: 9, taggedCount: 0, switchTry: 8, switchSuccess: 8, survivedMs: 120_000,
        }],
    };

    const deltas = accountStatsDeltas(result);
    assert.equal(deltas.length, 1);
    assert.deepEqual({
        userId: deltas[0]!.userId,
        games: deltas[0]!.games,
        survivedMs: deltas[0]!.survivedMs,
        tagCount: deltas[0]!.tagCount,
    }, { userId: 7, games: 1, survivedMs: 90_000, tagCount: 3 });
    assert.ok(deltas[0]!.xp > 0);
    assert.equal('level' in deltas[0]!, false);
    assert.equal(linkedParticipantUserId(result.players[0]!, new Set([7])), 7);
    assert.equal(linkedParticipantUserId(result.players[0]!, new Set()), null, '탈퇴 뒤 도착한 결과는 연결하지 않는다');
    assert.equal(linkedParticipantUserId(result.players[1]!, new Set([7])), null);
});

test('새 계정 통계 기본값에도 저장 레벨은 없고 생존시간 누적 분모가 있다', () => {
    const column = getTableConfig(schema.users).columns.find((item) => item.name === 'stats')!;
    const value = column.default as Record<string, unknown>;
    assert.equal('level' in value, false);
    assert.equal(value.survived_ms, 0);
    assert.equal(value.survived_games, 0);
});
