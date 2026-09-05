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
        winnerPlayerIds: [1, 2],
        replay: null,
        players: [
            {
                userId: 10, playerId: 1, nickname: 'Alice', colorIndex: 0, isGuest: false,
                tagCount: 2, taggedCount: 1, switchTry: 3, switchSuccess: 2, survivedMs: 60_000,
            },
            {
                userId: null, playerId: 2, nickname: 'Guest_7KPW2M', colorIndex: 1, isGuest: true,
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
    duplicateSlot.players[1].playerId = 1;
    assert.equal(isMatchResult(duplicateSlot), false);

    const impossibleSwitches = validResult();
    impossibleSwitches.players[0].switchSuccess = 4;
    assert.equal(isMatchResult(impossibleSwitches), false);
});

test('rejects playerId 0 and accepts playerId 8', () => {
    const zero = validResult();
    zero.players[0].playerId = 0;
    zero.winnerPlayerIds = [0, 2];
    assert.equal(isMatchResult(zero), false);

    const eight = validResult();
    eight.players[1].playerId = 8;
    eight.winnerPlayerIds = [1, 8];
    assert.equal(isMatchResult(eight), true);
});

test('accepts non-empty unique winner lists from one through eight players', () => {
    const singleWinner = validResult();
    singleWinner.winnerPlayerIds = [1];
    assert.equal(isMatchResult(singleWinner), true);

    const eightWinners = validResult();
    eightWinners.players = Array.from({ length: 8 }, (_value, index) => ({
        userId: null,
        playerId: index + 1,
        nickname: `Guest_${index + 1}`,
        colorIndex: index,
        isGuest: true,
        tagCount: 0,
        taggedCount: 0,
        switchTry: 0,
        switchSuccess: 0,
        survivedMs: 60_000,
    }));
    eightWinners.winnerPlayerIds = eightWinners.players.map((player) => player.playerId);
    assert.equal(isMatchResult(eightWinners), true);
});

test('rejects empty, duplicate, out-of-roster, and over-limit winner lists', () => {
    const empty = validResult();
    empty.winnerPlayerIds = [];
    assert.equal(isMatchResult(empty), false);

    const duplicate = validResult();
    duplicate.winnerPlayerIds = [1, 1];
    assert.equal(isMatchResult(duplicate), false);

    const outsideRoster = validResult();
    outsideRoster.winnerPlayerIds = [1, 3];
    assert.equal(isMatchResult(outsideRoster), false);

    const overLimit = validResult();
    overLimit.winnerPlayerIds = [1, 2, 1, 2, 1, 2, 1, 2, 1];
    assert.equal(isMatchResult(overLimit), false);
});

test('rejects results above documented sanity limits', () => {
    const result = validResult();
    result.endedAt = result.startedAt + 60 * 60 * 1_000 + 1;
    assert.equal(isMatchResult(result), false);
});
