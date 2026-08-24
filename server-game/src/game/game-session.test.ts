import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeSnapshot, SkillId, SkillRejection, SkillSlot, TilePhysics } from 'shared';
import { EMOJI_DISPLAY_MS } from '../config/gameplay';
import type { ReplayRecorder } from '../replay/recorder';
import { msToTicks } from '../simulation/effects';
import type { Room } from '../rooms/room';
import { mapFromRows, makePlayer, makeWorld } from '../simulation/testing';
import { GameSession } from './game-session';

test('a failed queued skill is returned to its requester at the tick boundary', () => {
    const rejected: { playerId: number; slot: number; reason: string }[] = [];
    const room = {
        id: 'room',
        participants: () => [1, 2, 3].map((playerId) => ({
            playerId,
            userId: playerId,
            nickname: `P${playerId}`,
            colorIndex: playerId - 1,
            guest: false,
        })),
        resolvedInputs: () => [],
        sendSkillRejected: (playerId: number, slot: number, reason: string) => {
            rejected.push({ playerId, slot, reason });
        },
        markEliminated: () => true,
        broadcastTagged: () => undefined,
        broadcastBlinked: () => undefined,
        finishGame: () => true,
        snapshotTargets: () => [],
    } as unknown as Room;
    const world = makeWorld(mapFromRows([
        '############',
        '#..........#',
        '#..........#',
        '#..........#',
        '############',
    ]), [
        makePlayer(1, 1, 1, { loadout: SkillId.Exhaust }),
        makePlayer(2, 8, 1),
        makePlayer(3, 8, 3),
    ]);
    const session = new GameSession({
        room,
        world,
        matchId: 'match',
        roster: [],
        violationSink: () => undefined,
        meta: { serverId: 'game', buildId: 'test', mapId: 'test', mapBundleHash: 'hash' },
        onFinished: () => undefined,
    });

    session.queueSkill({ playerId: 1, slot: SkillSlot.Movement });
    session.step();

    assert.deepEqual(rejected, [{
        playerId: 1,
        slot: SkillSlot.Movement,
        reason: SkillRejection.OutOfRange,
    }]);
});

test('queued emojis keep the last request per player and apply only for living players', () => {
    const room = {
        id: 'room',
        participants: () => [],
        resolvedInputs: () => [],
        sendSkillRejected: () => undefined,
        markEliminated: () => true,
        broadcastTagged: () => undefined,
        broadcastBlinked: () => undefined,
        finishGame: () => true,
        snapshotTargets: () => [],
    } as unknown as Room;
    const world = makeWorld(mapFromRows(['#####', '#...#', '#...#', '#####']), [
        makePlayer(3, 1, 1),
        makePlayer(1, 2, 1),
        makePlayer(2, 3, 1, { alive: false }),
        makePlayer(4, 1, 2),
    ]);
    const session = new GameSession({
        room,
        world,
        matchId: 'match',
        roster: [],
        violationSink: () => undefined,
        meta: { serverId: 'game', buildId: 'test', mapId: 'test', mapBundleHash: 'hash' },
        onFinished: () => undefined,
    });

    session.queueEmoji({ playerId: 3, emojiId: 3 });
    session.queueEmoji({ playerId: 1, emojiId: 1 });
    session.queueEmoji({ playerId: 3, emojiId: 4 });
    session.queueEmoji({ playerId: 2, emojiId: 2 });

    assert.equal(world.players.find((player) => player.playerId === 3)?.emoji, null);
    session.step();

    const expiresAtTick = world.tick + msToTicks(EMOJI_DISPLAY_MS, world.simulationHz);
    assert.deepEqual(world.players.map((player) => [player.playerId, player.emoji]), [
        [3, { emojiId: 4, expiresAtTick }],
        [1, { emojiId: 1, expiresAtTick }],
        [2, null],
        [4, null],
    ]);

    for (let i = 0; i < msToTicks(EMOJI_DISPLAY_MS, world.simulationHz) - 1; i++) session.step();
    assert.equal(world.players.find((player) => player.playerId === 1)?.emoji?.emojiId, 1);
    session.step();
    assert.equal(world.players.find((player) => player.playerId === 1)?.emoji, null);
});

test('publish 사이의 timeline tile 변경을 delta와 replay에 모두 한 번만 담는다', () => {
    const sent: ArrayBuffer[] = [];
    const replayFrames: ArrayBuffer[] = [];
    const recorder: ReplayRecorder = {
        begin: () => undefined,
        writeFrame: (_tick, bytes) => replayFrames.push(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
        writeVisibility: () => undefined,
        writeEvent: () => undefined,
        finish: async () => null,
        abort: () => undefined,
    };
    const room = {
        id: 'room',
        participants: () => [],
        resolvedInputs: () => [],
        sendSkillRejected: () => undefined,
        markEliminated: () => true,
        broadcastTagged: () => undefined,
        broadcastBlinked: () => undefined,
        finishGame: () => true,
        snapshotTargets: () => [{
            playerId: 1,
            access: 'unfiltered' as const,
            connection: { bufferedBytes: () => 0, sendBinary: (payload: ArrayBuffer) => sent.push(payload) },
        }],
    } as unknown as Room;
    const world = makeWorld(mapFromRows(['#####', '#...#', '#...#', '#####']), [
        makePlayer(1, 1, 1), makePlayer(2, 2, 1), makePlayer(3, 3, 1),
    ]);
    world.map.timeline = {
        2: [[1, 1, TilePhysics.Wall]],
        3: [[2, 1, TilePhysics.Wall]],
    };
    const session = new GameSession({
        room, world, matchId: 'match', roster: [], recorder,
        violationSink: () => undefined,
        meta: { serverId: 'game', buildId: 'test', mapId: 'test', mapBundleHash: 'hash' },
        onFinished: () => undefined,
    });

    session.publish(session.step()!); // tick 1 full snapshot
    sent.length = 0;
    const second = session.step()!;
    session.step()!;
    const fourth = session.step()!;
    assert.deepEqual(second.world.tileChanges, [], '다음 tick은 simulation의 이번-tick 배열을 정상적으로 비운다');
    session.publish(fourth);

    const delta = decodeSnapshot(sent[0]!);
    assert.deepEqual(delta.tileChanges, [
        { x: 1, y: 1, physics: TilePhysics.Wall },
        { x: 2, y: 1, physics: TilePhysics.Wall },
    ]);
    assert.deepEqual(decodeSnapshot(replayFrames.at(-1)!).tileChanges, delta.tileChanges, '리플레이도 publish 프레임을 기록한다');

    session.publish(session.step()!);
    assert.equal(decodeSnapshot(sent.at(-1)!).tileChanges, undefined, 'publish 뒤에는 같은 변경을 다시 보내지 않는다');
});

test('full 및 delta 뷰어가 섞여도 delta가 누적 타일 변경을 잃지 않는다', () => {
    const fullSent: ArrayBuffer[] = [];
    const deltaSent: ArrayBuffer[] = [];
    const room = {
        id: 'room',
        participants: () => [],
        resolvedInputs: () => [],
        sendSkillRejected: () => undefined,
        markEliminated: () => true,
        broadcastTagged: () => undefined,
        broadcastBlinked: () => undefined,
        finishGame: () => true,
        snapshotTargets: () => [
            { playerId: 1, access: 'unfiltered' as const, connection: { bufferedBytes: () => 0, sendBinary: (payload: ArrayBuffer) => fullSent.push(payload) } },
            { playerId: 2, access: 'unfiltered' as const, connection: { bufferedBytes: () => 0, sendBinary: (payload: ArrayBuffer) => deltaSent.push(payload) } },
        ],
    } as unknown as Room;
    const world = makeWorld(mapFromRows(['#####', '#...#', '#...#', '#####']), [
        makePlayer(1, 1, 1), makePlayer(2, 2, 1), makePlayer(3, 3, 1),
    ]);
    world.map.timeline = { 2: [[1, 1, TilePhysics.Wall]], 3: [[2, 1, TilePhysics.Wall]] };
    const session = new GameSession({
        room, world, matchId: 'match', roster: [], violationSink: () => undefined,
        meta: { serverId: 'game', buildId: 'test', mapId: 'test', mapBundleHash: 'hash' }, onFinished: () => undefined,
    });

    session.publish(session.step()!); // both initial full
    fullSent.length = 0;
    deltaSent.length = 0;
    session.requestFullSnapshot(1);
    session.step()!;
    session.step()!;
    session.publish(session.step()!);

    const full = decodeSnapshot(fullSent[0]!);
    const delta = decodeSnapshot(deltaSent[0]!);
    assert.ok(full.map, '재접속 뷰어는 전체 맵을 받는다');
    assert.equal(full.tileChanges, undefined, 'full snapshot은 누적 delta가 필요 없다');
    assert.deepEqual(delta.tileChanges, [
        { x: 1, y: 1, physics: TilePhysics.Wall },
        { x: 2, y: 1, physics: TilePhysics.Wall },
    ]);
});
