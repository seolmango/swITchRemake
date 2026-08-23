import assert from 'node:assert/strict';
import test from 'node:test';
import { MATCH_RESULT_VERSION, type MatchResultMessage } from 'shared';
import { decodeMatchResult, isMatchResult } from './result.codec';

function validResult(): MatchResultMessage {
    return {
        v: MATCH_RESULT_VERSION,
        matchId: '11111111-1111-4111-8111-111111111111',
        roomId: 'room-a',
        serverId: 'game-a',
        mapId: 'map-a',
        startedAt: 1_000,
        endedAt: 61_000,
        durationTicks: 1_800,
        buildId: 'build-a',
        protocolVersion: 1,
        rulesVersion: 'rules-a',
        mapBundleHash: 'bundle-a',
        visibilityCoreVersion: 1,
        winnerPlayerIds: [0, 1],
        replay: null,
        players: [
            {
                userId: 10, playerId: 0, nickname: 'Alice', colorIndex: 0, isGuest: false,
                tagCount: 2, taggedCount: 1, switchTry: 3, switchSuccess: 2, survivedMs: 60_000,
            },
            {
                userId: null, playerId: 1, nickname: 'Guest_7KPW2M', colorIndex: 1, isGuest: true,
                tagCount: 1, taggedCount: 2, switchTry: 1, switchSuccess: 1, survivedMs: 60_000,
            },
        ],
    };
}

test('decodes a complete version-stamped result including a guest', () => {
    const result = validResult();
    assert.deepEqual(decodeMatchResult(JSON.stringify(result)), result);
});

test('rejects malformed identity, duplicate slots, and impossible counters', () => {
    const guestWithAccount = validResult();
    guestWithAccount.players[1].userId = 11;
    assert.equal(isMatchResult(guestWithAccount), false);

    const duplicateSlot = validResult();
    duplicateSlot.players[1].playerId = 0;
    assert.equal(isMatchResult(duplicateSlot), false);

    const impossibleSwitches = validResult();
    impossibleSwitches.players[0].switchSuccess = 4;
    assert.equal(isMatchResult(impossibleSwitches), false);
});

test('rejects results above documented sanity limits', () => {
    const result = validResult();
    result.endedAt = result.startedAt + 60 * 60 * 1_000 + 1;
    assert.equal(isMatchResult(result), false);
});
