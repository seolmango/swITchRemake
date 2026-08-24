import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_PLAYERS_PER_ROOM, SkillId, TilePhysics } from 'shared';
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
