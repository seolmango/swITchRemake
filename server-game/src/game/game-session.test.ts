import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SkillId, SkillRejection, SkillSlot } from 'shared';
import { EMOJI_DISPLAY_MS } from '../config/gameplay';
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
            colorIndex: playerId,
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
