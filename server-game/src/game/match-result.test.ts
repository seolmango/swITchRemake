import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROTOCOL_VERSION, statsEligible, VISIBILITY_CORE_VERSION, winnerUserIds, type MatchResultMessage, type ReplayHandleInfo , RoomMode } from 'shared';
import { RULES_VERSION } from '../config/gameplay';
import type { ReplayMeta, ReplayOutcome, ReplayRecorder } from '../replay/recorder';
import { GameSession } from './game-session';
import { stepWorld } from '../simulation/step';
import { mapFromRows, makePlayer, makeWorld } from '../simulation/testing';
import type { Room } from '../rooms/room';

const MAP = [
    '#######',
    '#.....#',
    '#.....#',
    '#.....#',
    '#######',
];

/**
 * Room을 통째로 세우지 않고 GameSession이 실제로 부르는 것만 흉내 낸다.
 * 이 목록이 곧 두 계층 사이의 실제 접점이라, 여기가 늘어나면 경계가 새고 있다는 뜻이다.
 */
function fakeRoom(): Room {
    return {
        id: 'room-1',
        resolvedInputs: () => [],
        snapshotTargets: () => [],
        markEliminated: () => true,
        broadcastTagged: () => undefined,
        broadcastBlinked: () => undefined,
        finishGame: () => true,
        participants: () => [
            { playerId: 1, userId: 11, nickname: '계정1', colorIndex: 1, guest: false },
            { playerId: 2, userId: 'g:abc', nickname: 'Guest_ab12cd', colorIndex: 2, guest: true },
            { playerId: 3, userId: 33, nickname: '계정3', colorIndex: 3, guest: false },
        ],
    } as unknown as Room;
}

function runToFinish(recorder?: ReplayRecorder): Promise<MatchResultMessage> {
    const world = makeWorld(mapFromRows(MAP), [
        makePlayer(1, 1, 1, { isTagger: true }),
        makePlayer(2, 3, 2),
        makePlayer(3, 5, 3),
    ]);

    return new Promise((resolve) => {
        const session = new GameSession({
            room: fakeRoom(),
            world,
            matchId: 'match-1',
            mode: RoomMode.Match,
            roster: [],
            violationSink: () => undefined,
            ...(recorder ? { recorder } : {}),
            meta: { serverId: 'game-test-p1', buildId: 'test-build', mapId: 'testmap', mapBundleHash: 'deadbeef' },
            // 리플레이 저장은 비동기다(finish()가 Promise). onFinished도 그래서 마이크로태스크 이후에
            // 불린다 — session.step() 직후가 아니라 이 콜백을 기다려야 한다.
            onFinished: (_session, result) => resolve(result),
        });

        // 경기를 조금 진행한 뒤 3번을 탈락시켜 생존자 2명 조건을 만든다.
        for (let i = 0; i < 30; i++) stepWorld(world, []);
        world.players[2]!.alive = false;
        world.players[2]!.stats.eliminatedAtTick = world.tick;
        world.players[0]!.stats.tagCount = 1;
        world.players[1]!.stats.switchTry = 3;
        world.players[1]!.stats.switchSuccess = 1;
        for (let i = 0; i < 20; i++) stepWorld(world, []);
        session.step();
    });
}

test('경기가 끝나면 결과 메시지가 만들어진다', async () => {
    const result = await runToFinish();
    assert.equal(result.matchId, 'match-1');
    assert.equal(result.roomId, 'room-1');
    assert.equal(result.serverId, 'game-test-p1');
    assert.equal(result.players.length, 3);
});

test('버전 스탬프가 빠짐없이 들어간다', async () => {
    // 나중에 채울 수 없는 값들이다. 컬럼을 추가해도 그 이전 경기는 영원히 빈다.
    const result = await runToFinish();
    assert.equal(result.buildId, 'test-build');
    assert.equal(result.protocolVersion, PROTOCOL_VERSION);
    assert.equal(result.rulesVersion, RULES_VERSION);
    assert.equal(result.mapBundleHash, 'deadbeef');
    assert.equal(result.visibilityCoreVersion, VISIBILITY_CORE_VERSION);
    assert.ok(result.durationTicks > 0);
});

test('게스트는 userId가 null이지만 행은 남는다', async () => {
    const result = await runToFinish();
    const guest = result.players.find((p) => p.playerId === 2);

    assert.ok(guest !== undefined, '게스트가 결과에서 통째로 빠졌다');
    assert.equal(guest.userId, null);
    assert.equal(guest.isGuest, true);
    assert.equal(guest.nickname, 'Guest_ab12cd', '당시 닉네임이 남아야 리플레이에 이름이 뜬다');
    assert.equal(statsEligible(result.players).length, 2, '전적 집계에서는 게스트가 빠져야 한다');
});

test('경기 중 누적한 수치가 실린다', async () => {
    const result = await runToFinish();
    const tagger = result.players.find((p) => p.playerId === 1)!;
    const switcher = result.players.find((p) => p.playerId === 2)!;

    assert.equal(tagger.tagCount, 1);
    assert.equal(switcher.switchTry, 3);
    assert.equal(switcher.switchSuccess, 1);
});

test('탈락한 사람의 생존 시간이 경기 전체 길이보다 짧다', async () => {
    const result = await runToFinish();
    const dead = result.players.find((p) => p.playerId === 3)!;
    const alive = result.players.find((p) => p.playerId === 1)!;
    assert.ok(dead.survivedMs < alive.survivedMs, '탈락 시점을 기록하지 않으면 계산할 수 없는 값이다');
});

test('승자는 계정이 아니라 slot으로 지목된다', async () => {
    // 게스트도 이길 수 있어서 userId 배열로는 표현할 방법이 없다.
    const result = await runToFinish();
    assert.deepEqual([...result.winnerPlayerIds].sort(), [1, 2]);

    // 게스트 승자는 계정 매핑에서 자연스럽게 빠진다.
    assert.deepEqual(winnerUserIds(result), [11]);
});

test('3인 경기에서 한 tick에 두 명이 동시에 잡히면 남은 한 명만 승자다', async () => {
    let announcedWinners: readonly number[] | null = null;
    const room = {
        ...fakeRoom(),
        finishGame: (winnerIds: readonly number[]) => {
            announcedWinners = winnerIds;
            return true;
        },
    } as unknown as Room;
    const world = makeWorld(mapFromRows(MAP), [
        makePlayer(3, 3, 2),
        makePlayer(1, 3, 2, { isTagger: true }),
        makePlayer(2, 3, 2),
    ]);

    const result = await new Promise<MatchResultMessage>((resolve) => {
        const session = new GameSession({
            room,
            world,
            matchId: 'simultaneous-elimination',
            mode: RoomMode.Match,
            roster: [],
            violationSink: () => undefined,
            meta: { serverId: 'game', buildId: 'test', mapId: 'testmap', mapBundleHash: 'hash' },
            onFinished: (_session, finished) => resolve(finished),
        });
        session.step();
    });

    assert.deepEqual(world.players.filter((player) => player.alive).map((player) => player.playerId), [1]);
    assert.deepEqual(announcedWinners, [1]);
    assert.deepEqual(result.winnerPlayerIds, [1], '한 자리를 복제해 두 명짜리 결과를 만들면 안 된다');
});

test('최대 tick에 도달하면 생존자 전원이 승리하고 정상 결과ㆍ리플레이 종료 경로를 탄다', async () => {
    const participantIds = [4, 2, 1, 3];
    let announcedWinners: readonly number[] | null = null;
    const room = {
        id: 'time-limit-room',
        participants: () => participantIds.map((playerId) => ({
            playerId,
            userId: playerId,
            nickname: `P${playerId}`,
            colorIndex: playerId - 1,
            guest: false,
        })),
        resolvedInputs: () => [],
        sendSkillRejected: () => undefined,
        markEliminated: () => true,
        broadcastTagged: () => undefined,
        broadcastBlinked: () => undefined,
        broadcastSkillArea: () => undefined,
        finishGame: (winnerIds: readonly number[]) => {
            announcedWinners = winnerIds;
            return true;
        },
        snapshotTargets: () => [],
    } as unknown as Room;
    const world = makeWorld(mapFromRows([
        '##########',
        '#........#',
        '#........#',
        '##########',
    ]), [
        makePlayer(4, 7, 1, { isTagger: true }),
        makePlayer(2, 5, 1),
        makePlayer(1, 1, 1),
        makePlayer(3, 3, 1),
    ]);
    const replayHandle: ReplayHandleInfo = {
        storageKey: 'time-limit.swrp',
        formatVersion: 1,
        chunkCount: 1,
        sizeBytes: 123,
        rootHash: 'b'.repeat(64),
    };
    const finalFrames: number[] = [];
    const replayFinishes: number[] = [];
    const recorder: ReplayRecorder = {
        begin: () => undefined,
        writeFrame: (tick, _frame, full) => { if (full) finalFrames.push(tick); },
        writeVisibility: () => undefined,
        writeEvent: () => undefined,
        finish: async (outcome) => { replayFinishes.push(outcome.endTick); return replayHandle; },
        abort: () => undefined,
    };
    let resolveResult!: (result: MatchResultMessage) => void;
    const resultPromise = new Promise<MatchResultMessage>((resolve) => { resolveResult = resolve; });
    const submittedResults: MatchResultMessage[] = [];
    const session = new GameSession({
        room,
        world,
        matchId: 'time-limit-match',
        mode: RoomMode.Match,
        roster: [],
        recorder,
        maxDurationTicks: 2,
        violationSink: () => undefined,
        meta: { serverId: 'game', buildId: 'test', mapId: 'testmap', mapBundleHash: 'hash' },
        onFinished: (_session, result) => {
            submittedResults.push(result);
            resolveResult(result);
        },
    });

    assert.equal(session.step()?.tick, 1);
    assert.equal(announcedWinners, null, '상한 직전 tick에는 끝나면 안 된다');
    assert.equal(session.step()?.tick, 2);
    assert.deepEqual(announcedWinners, [1, 2, 3, 4], '술래를 포함한 생존자 전원을 번호순으로 알린다');

    const result = await resultPromise;
    assert.equal(result.durationTicks, 2);
    assert.deepEqual(result.winnerPlayerIds, [1, 2, 3, 4]);
    assert.deepEqual(finalFrames, [2], '상한 도달 tick이 마지막 keyframe이어야 한다');
    assert.deepEqual(replayFinishes, [2], '정상 종료와 같은 endTick으로 리플레이를 마감해야 한다');
    assert.deepEqual(result.replay, replayHandle);
    assert.equal(submittedResults.length, 1, '결과 저장 경계에는 한 번만 제출해야 한다');
    assert.equal(session.step(), null, '종료 뒤에는 tick이 더 진행되면 안 된다');
});

test('레코더를 안 주면 리플레이는 null로 표현한다', async () => {
    assert.equal((await runToFinish()).replay, null);
});

test('레코더가 만든 handle이 결과 메시지에 그대로 실린다', async () => {
    const handle: ReplayHandleInfo = {
        storageKey: 'match-1.swrp',
        formatVersion: 1,
        chunkCount: 1,
        sizeBytes: 1234,
        rootHash: 'a'.repeat(64),
    };
    const recorder: ReplayRecorder = {
        begin: (_meta: ReplayMeta) => undefined,
        writeFrame: () => undefined,
        writeVisibility: () => undefined,
        writeEvent: () => undefined,
        finish: async (_outcome: ReplayOutcome) => handle,
        abort: () => undefined,
    };

    const result = await runToFinish(recorder);
    assert.deepEqual(result.replay, handle);
});

test('레코더가 저장에 실패(abort)하면 replay는 null이지 경기 결과 자체는 그대로 만들어진다', async () => {
    const recorder: ReplayRecorder = {
        begin: () => undefined,
        writeFrame: () => undefined,
        writeVisibility: () => undefined,
        writeEvent: () => undefined,
        finish: async () => null,
        abort: () => undefined,
    };

    const result = await runToFinish(recorder);
    assert.equal(result.replay, null);
    assert.equal(result.players.length, 3, '리플레이 실패가 경기 결과 저장 자체를 막으면 안 된다');
});

test('로스터 밖 world 액터는 결과와 전적 행에 들어가지 않는다', async () => {
    const world = makeWorld(mapFromRows(MAP), [
        makePlayer(1, 1, 1),
        makePlayer(2, 3, 2),
        makePlayer(3, 5, 3, { alive: false }),
        makePlayer(4, 4, 1, { alive: false }),
    ]);

    const result = await new Promise<MatchResultMessage>((resolve) => {
        const session = new GameSession({
            room: fakeRoom(),
            world,
            matchId: 'match-with-world-actor',
            mode: RoomMode.Match,
            roster: [],
            violationSink: () => undefined,
            meta: { serverId: 'game', buildId: 'test', mapId: 'testmap', mapBundleHash: 'hash' },
            onFinished: (_session, finished) => resolve(finished),
        });
        session.step();
    });

    assert.deepEqual(result.players.map((player) => player.playerId), [1, 2, 3]);
    assert.deepEqual(result.winnerPlayerIds, [1, 2]);
});
