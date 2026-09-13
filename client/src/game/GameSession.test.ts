// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSON_MESSAGE_VERSION, RoomMode, RoomState, type Snapshot, type SnapshotPlayer } from 'shared';
import { gameSession } from './GameSession.ts';

class TestSocket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    static current: TestSocket;
    readyState = 1;
    send = vi.fn();
    constructor() { super(); TestSocket.current = this; }
    close() { this.readyState = 3; }
    message(type: string, payload: unknown) {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ v: JSON_MESSAGE_VERSION, type, payload, eventId: 1, serverTick: 1 }) }));
    }
}
const player = (id: number, isTagger: boolean): SnapshotPlayer => ({
    id, isTagger, colorIndex: id - 1, x: 100, y: 100, facingX: 1, facingY: 0, obscured: false, effects: {},
});
const snapshot = (fields: Partial<Snapshot> = {}): Snapshot => ({ version: 1, full: false, tick: 1, ...fields });
const lobby = (role = 'player') => ({
    selfId: 1, hostId: 1, roomName: 'training', mapId: 'training', mode: RoomMode.Training,
    capacity: 8, locked: false, startLockMs: 0,
    players: [{ playerId: 1, slot: 1, nickname: 'self', colorIndex: 0, guest: true, role, skills: ['dash'], stats: null }],
});

describe('training session authoritative snapshot transitions', () => {
    beforeEach(async () => {
        vi.stubGlobal('WebSocket', TestSocket);
        const connected = gameSession.connect({ roomId: 'training', roomCode: '1234', ticket: 'test', wsPath: 'ws://localhost/game-ws', expiresAt: Date.now() + 30_000 });
        TestSocket.current.message('auth.ok', { roomId: 'training', playerId: 1, roomState: RoomState.Playing, role: 'player', mapBundleHash: 'test' });
        await connected;
        TestSocket.current.message('lobby.state', lobby());
        gameSession.updateHudSnapshot(snapshot({ roster: [{ id: 1, nickname: 'self' }, { id: 2, nickname: 'dummy' }], players: [player(1, false), player(2, false)] }));
    });
    afterEach(() => { gameSession.disconnect(); vi.unstubAllGlobals(); });

    it('publishes multiple taggers and clears explicit runner flags immediately', () => {
        gameSession.updateHudSnapshot(snapshot({ players: [player(1, true), player(2, true)] }));
        expect(gameSession.getSnapshot().trainingPlayers.map((entry) => entry.isTagger)).toEqual([true, true]);
        gameSession.updateHudSnapshot(snapshot({ players: [player(1, false), player(2, true)] }));
        expect(gameSession.getSnapshot().trainingPlayers.map((entry) => entry.isTagger)).toEqual([false, true]);
        gameSession.updateHudSnapshot(snapshot({ players: [player(1, false), player(2, false)] }));
        expect(gameSession.getSnapshot().taggerId).toBeNull();
        expect(gameSession.getSnapshot().trainingPlayers.every((entry) => !entry.isTagger)).toBe(true);
    });

    it('does not confuse hidden players with elimination and revives on reappearance', () => {
        TestSocket.current.message('player.eliminated', { playerId: 1 });
        gameSession.updateHudSnapshot(snapshot({ players: [] }));
        expect(gameSession.getSnapshot().trainingPlayers.map((entry) => entry.alive)).toEqual([false, true]);
        TestSocket.current.message('lobby.state', lobby('spectator'));
        expect(gameSession.getSnapshot().role).toBe('spectator');
        TestSocket.current.message('lobby.state', lobby());
        gameSession.updateHudSnapshot(snapshot({ players: [player(1, false)] }));
        expect(gameSession.getSnapshot().role).toBe('player');
        expect(gameSession.getSnapshot().trainingPlayers[0]?.alive).toBe(true);
    });

    it('preserves optional player and cooldown sections on partial frames', () => {
        gameSession.updateHudSnapshot(snapshot({ players: [player(1, true)], cooldowns: [{ slot: 0, remainingMs: 1500 }] }));
        gameSession.updateHudSnapshot(snapshot());
        expect(gameSession.getSnapshot().trainingPlayers[0]?.isTagger).toBe(true);
        expect(gameSession.getSnapshot().cooldowns).toEqual([{ slot: 0, remainingMs: 1500 }]);
        gameSession.updateHudSnapshot(snapshot({ players: [], cooldowns: [] }));
        expect(gameSession.getSnapshot().taggerId).toBe(1);
        expect(gameSession.getSnapshot().cooldowns).toEqual([]);
    });
});
