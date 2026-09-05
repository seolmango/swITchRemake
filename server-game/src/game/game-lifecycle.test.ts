import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    decodeSnapshot,
    MAX_PLAYERS_PER_ROOM,
    SkillId,
    TilePhysics,
    RoomMode,
    MapMarkerKind,
    MapZoneKind,
    type MatchResultMessage,
    type ReplayHandleInfo,
} from 'shared';
import { EMOJI_DISPLAY_MS } from '../config/gameplay';
import type { ServerMapBundle } from '../maps/map-loader';
import type { ReplayRecorder } from '../replay/recorder';
import type { Room, RoomStartSnapshot } from '../rooms/room';
import { msToTicks } from '../simulation/effects';
import { Scheduler } from '../simulation/scheduler';
import { GameLifecycle } from './game-lifecycle';

const bundle: ServerMapBundle = {
    schemaVersion: 1,
    mapBundleHash: 'test-hash',
    simulationHz: 30,
    tileSize: 256,
    maps: {
        map: {
            mapId: 'map',
            size: 5,
            barrierSpeed: 1,
            trainingOnly: false,
            initialMap: Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => TilePhysics.Floor)),
            timeline: {},
            startPositions: {
                3: [[384, 384], [640, 384], [896, 384]],
            },
            // 표적 자리는 맵이 정한다. 훈련 테스트가 실제와 같은 경로를 타려면 마커가 있어야 한다.
            markers: [
                { kind: MapMarkerKind.TrainingDummyStill, x: 1, y: 1 },
                { kind: MapMarkerKind.TrainingDummyPatrol, x: 3, y: 1 },
                { kind: MapMarkerKind.TrainingDummyChase, x: 1, y: 3 },
            ],
            zones: [
                { kind: MapZoneKind.TrainingCourse, x: 2, y: 0, width: 3, height: 3 },
                { kind: MapZoneKind.TrainingChase, x: 0, y: 3, width: 5, height: 2 },
            ],
        },
    },
};

function fakeRoom(): Room {
    return {
        id: 'room',
        nicknameOf: (playerId: number) => `P${playerId}`,
        participants: () => [1, 2, 3].map((playerId) => ({
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
        finishGame: () => true,
        snapshotTargets: () => [],
    } as unknown as Room;
}

test('selected loadouts enter PlayerState and a missing recovered value falls back to dash', () => {
    const room = fakeRoom();
    const lifecycle = new GameLifecycle({
        bundle,
        serverId: 'game',
        buildId: 'test',
        scheduler: new Scheduler(),
        lookupRoom: () => room,
        violationSink: () => undefined,
        makeSeed: () => 1,
    });
    const snapshot: RoomStartSnapshot = {
        roomId: 'room',
        matchId: 'match',
        mapId: 'map',
        mode: RoomMode.Match,
        players: [
            { playerId: 1, loadout: SkillId.Flash },
            { playerId: 2 },
            { playerId: 3, loadout: SkillId.Exhaust },
        ],
        rules: {},
    };

    lifecycle.startGame(snapshot);
    const players = lifecycle.session('room')!.world.players;

    assert.equal(players.find((player) => player.playerId === 1)?.loadout, SkillId.Flash);
    assert.equal(players.find((player) => player.playerId === 2)?.loadout, SkillId.Dash);
    assert.equal(players.find((player) => player.playerId === 3)?.loadout, SkillId.Exhaust);
});

test('in-game colorIndex maps every one-based playerId into the zero-based palette', () => {
    const lifecycle = new GameLifecycle({
        bundle,
        serverId: 'game',
        buildId: 'test',
        scheduler: new Scheduler(),
        lookupRoom: () => fakeRoom(),
        violationSink: () => undefined,
        makeSeed: () => 1,
    });
    lifecycle.startGame({
        roomId: 'room',
        matchId: 'match-colors',
        mapId: 'map',
        mode: RoomMode.Match,
        players: Array.from({ length: MAX_PLAYERS_PER_ROOM }, (_, index) => ({ playerId: index + 1 })),
        rules: {},
    });

    assert.deepEqual(lifecycle.session('room')!.world.players.map((player) => player.colorIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('emoji request is applied at the next tick boundary with a gameplay-configured expiry', () => {
    const room = fakeRoom();
    const lifecycle = new GameLifecycle({
        bundle,
        serverId: 'game',
        buildId: 'test',
        scheduler: new Scheduler(),
        lookupRoom: () => room,
        violationSink: () => undefined,
        makeSeed: () => 1,
    });
    lifecycle.startGame({
        roomId: 'room',
        matchId: 'match',
        mapId: 'map',
        mode: RoomMode.Match,
        players: [{ playerId: 1 }, { playerId: 2 }, { playerId: 3 }],
        rules: {},
    });
    const session = lifecycle.session('room')!;

    assert.equal(lifecycle.setEmoji('room', { playerId: 2, emojiId: 9 }), true);
    assert.equal(session.world.players.find((player) => player.playerId === 2)?.emoji, null);
    session.step();
    assert.deepEqual(session.world.players.find((player) => player.playerId === 2)?.emoji, {
        emojiId: 9,
        expiresAtTick: session.world.tick + msToTicks(EMOJI_DISPLAY_MS, session.world.simulationHz),
    });
});

test('훈련장에만 이름이 붙은 더미가 생기며 로비 참가자로 등록되지 않는다', () => {
    const sent: ArrayBuffer[] = [];
    const finished: string[] = [];
    const participants = [{ playerId: 1, userId: 1, nickname: '연습생', colorIndex: 0, guest: false }];
    const room = {
        ...fakeRoom(),
        participants: () => participants,
        nicknameOf: () => '연습생',
        snapshotTargets: () => [{
            playerId: 1,
            access: 'unfiltered' as const,
            connection: { bufferedBytes: () => 0, sendBinary: (payload: ArrayBuffer) => sent.push(payload) },
        }],
    } as unknown as Room;
    const lifecycle = new GameLifecycle({
        bundle,
        serverId: 'game',
        buildId: 'test',
        scheduler: new Scheduler(),
        lookupRoom: () => room,
        violationSink: () => undefined,
        makeSeed: () => 1,
        onMatchFinished: () => finished.push('result'),
    });

    lifecycle.startGame({
        roomId: 'room', matchId: 'training', mapId: 'map', mode: RoomMode.Training,
        players: [{ playerId: 1 }], rules: {},
    });
    const trainingSession = lifecycle.session('room')!;
    assert.equal(trainingSession.world.players.length, 4);
    assert.equal(participants.length, 1, 'LobbyRoster에 해당하는 실제 참가자 목록은 그대로다');
    trainingSession.publish(trainingSession.step()!);
    assert.deepEqual(
        decodeSnapshot(sent[0]!).roster?.map((entry) => entry.nickname),
        ['연습생', '[표적] 정지', '[표적] 순찰', '[표적] 추격'],
    );
    for (const dummy of trainingSession.world.players.slice(1)) dummy.alive = false;
    assert.notEqual(trainingSession.step(), null);
    assert.deepEqual(finished, [], '더미가 모두 탈락해도 훈련 결과를 내보내지 않는다');

    lifecycle.stopRoom('room');
    lifecycle.startGame({
        roomId: 'room', matchId: 'match', mapId: 'map', mode: RoomMode.Match,
        players: [{ playerId: 1 }, { playerId: 2 }, { playerId: 3 }], rules: {},
    });
    assert.equal(lifecycle.session('room')!.world.players.length, 3, '경기 방에는 더미가 들어가지 않는다');
});

test('3인 경기의 연결 종료는 즉시 승자를 정하고 결과 저장과 리플레이 마감을 완료한다', async () => {
    let announcedWinners: readonly number[] | null = null;
    const room = {
        ...fakeRoom(),
        finishGame: (winnerIds: readonly number[]) => {
            announcedWinners = winnerIds;
            return true;
        },
    } as unknown as Room;
    const replayHandle: ReplayHandleInfo = {
        storageKey: 'disconnect.swrp',
        formatVersion: 1,
        chunkCount: 1,
        sizeBytes: 123,
        rootHash: 'a'.repeat(64),
    };
    const recorded: { finalFrames: number[]; events: string[]; finishedAt: number[] } = {
        finalFrames: [], events: [], finishedAt: [],
    };
    const recorder: ReplayRecorder = {
        begin: () => undefined,
        writeFrame: (tick, _frame, full) => { if (full) recorded.finalFrames.push(tick); },
        writeVisibility: () => undefined,
        writeEvent: (_tick, event) => { recorded.events.push(event.kind); },
        finish: async (outcome) => { recorded.finishedAt.push(outcome.endTick); return replayHandle; },
        abort: () => undefined,
    };
    let resolveResult!: (result: MatchResultMessage) => void;
    const resultPromise = new Promise<MatchResultMessage>((resolve) => { resolveResult = resolve; });
    const lifecycle = new GameLifecycle({
        bundle,
        serverId: 'game',
        buildId: 'test',
        scheduler: new Scheduler(),
        lookupRoom: () => room,
        violationSink: () => undefined,
        makeSeed: () => 1,
        replayRecorderFactory: () => recorder,
        onMatchFinished: (_session, result) => resolveResult(result),
    });
    lifecycle.startGame({
        roomId: 'room', matchId: 'disconnect-match', mapId: 'map', mode: RoomMode.Match,
        players: [{ playerId: 1 }, { playerId: 2 }, { playerId: 3 }], rules: {},
    });

    lifecycle.participantDisconnected('room', 3);
    assert.deepEqual(announcedWinners, [1, 2], '다음 tick까지 종료 판정을 미루면 안 된다');

    const result = await resultPromise;
    assert.deepEqual(result.winnerPlayerIds, [1, 2]);
    assert.deepEqual(recorded.events, ['eliminated']);
    assert.deepEqual(recorded.finalFrames, [0]);
    assert.deepEqual(recorded.finishedAt, [0]);
    assert.deepEqual(result.replay, replayHandle);
});

test('경기 시작 rules snapshot의 최대 tick을 세션이 끝까지 사용한다', async () => {
    let announcedWinners: readonly number[] | null = null;
    const room = {
        ...fakeRoom(),
        finishGame: (winnerIds: readonly number[]) => {
            announcedWinners = winnerIds;
            return true;
        },
    } as unknown as Room;
    let resolveResult!: (result: MatchResultMessage) => void;
    const resultPromise = new Promise<MatchResultMessage>((resolve) => { resolveResult = resolve; });
    const lifecycle = new GameLifecycle({
        bundle,
        serverId: 'game',
        buildId: 'test',
        scheduler: new Scheduler(),
        lookupRoom: () => room,
        violationSink: () => undefined,
        makeSeed: () => 1,
        onMatchFinished: (_session, result) => resolveResult(result),
    });
    lifecycle.startGame({
        roomId: 'room',
        matchId: 'short-snapshot-match',
        mapId: 'map',
        mode: RoomMode.Match,
        players: [{ playerId: 1 }, { playerId: 2 }, { playerId: 3 }],
        rules: { MAX_MATCH_DURATION_TICKS: 2 },
    });
    const session = lifecycle.session('room')!;

    assert.equal(session.step()?.tick, 1);
    assert.equal(announcedWinners, null);
    assert.equal(session.step()?.tick, 2);

    const result = await resultPromise;
    assert.deepEqual(announcedWinners, [1, 2, 3]);
    assert.deepEqual(result.winnerPlayerIds, [1, 2, 3]);
    assert.equal(result.durationTicks, 2);
});
