import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeSnapshot, MAX_PLAYERS_PER_ROOM, SkillId, TilePhysics, RoomMode } from 'shared';
import { EMOJI_DISPLAY_MS } from '../config/gameplay';
import type { ServerMapBundle } from '../maps/map-loader';
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
            initialMap: Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => TilePhysics.Floor)),
            timeline: {},
            startPositions: {
                3: [[384, 384], [640, 384], [896, 384]],
            },
        markers: [],
        zones: [],
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
        ['연습생', '[더미] 고정', '[더미] 왕복', '[더미] 순환'],
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
