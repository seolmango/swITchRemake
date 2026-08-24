import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    encodeInput,
    ErrorCode,
    JSON_MESSAGE_VERSION,
    MovementBits,
    RoomState,
    SkillId,
    type ClientMessage,
    type ViolationSignal,
} from 'shared';
import type { SeatReservation } from '../gateway/ticket-store';
import type { Connection } from '../transport/game-transport';
import { RoomManager } from './room-manager';
import type { RoomLifecyclePort } from './room';

class FakeConnection implements Connection {
    readonly messages: Parameters<Connection['sendJson']>[0][] = [];
    readonly lobbyStats = null;
    public constructor(
        readonly id: number,
        readonly userId: number,
        readonly nickname: string,
        readonly roomId: string,
        readonly playerId: number,
        readonly resume = false,
        readonly isGuest = false,
    ) {}
    public sendJson(message: Parameters<Connection['sendJson']>[0]): void { this.messages.push(message); }
    public sendBinary(_payload: ArrayBuffer): void {}
    public bufferedBytes(): number { return 0; }
    public close(_code: number, _reason: string): void {}
}

const lifecycle: RoomLifecyclePort = {
    startGame: (snapshot) => ({ startTick: 1, taggerId: snapshot.players[0]!.playerId }),
    connectionChanged: () => undefined,
    participantTimedOut: () => undefined,
    participantRemoved: () => undefined,
};

function seat(userId: number, resume = false): SeatReservation {
    return {
        userId,
        nickname: `p${userId}`,
        lobbyStats: null,
        roomId: 'room',
        serverId: 'game',
        issuedAt: 0,
        expiresAt: 15_000,
        resume,
    };
}

function loadoutMessage(skills: string[]): ClientMessage {
    return {
        v: JSON_MESSAGE_VERSION,
        type: 'lobby.setLoadout',
        requestId: 42,
        payload: { skills },
    } as unknown as ClientMessage;
}

function errorCode(connection: FakeConnection): string | null {
    const message = connection.messages.at(-1);
    return message?.type === 'error' ? message.payload.code : null;
}

function managerFixture() {
    let now = 0;
    let directoryChanges = 0;
    const emojis: { playerId: number; emojiId: number }[] = [];
    const manager = new RoomManager({
        lifecycle,
        isKnownMap: (mapId) => mapId === 'map',
        getServerTick: () => 7,
        violationSink: () => undefined,
        emojiSink: (_roomId, request) => { emojis.push(request); return true; },
        now: () => now,
        timing: {
            countdownMs: 0,
            startLockOnJoinMs: 0,
            startLockOnMapChangeMs: 0,
        },
        onDirectoryChanged: () => { directoryChanges += 1; },
    });
    const ownerSeat = seat(1);
    const created = manager.createRoom({
        id: 'room', roomCode: 'ABC234', matchId: 'match', name: 'name', password: null,
        capacity: 8, mapId: 'map', ownerReservation: ownerSeat,
    });
    assert.equal(created.ok, true);
    const admission = manager.admitReservation(ownerSeat)!;
    const owner = new FakeConnection(1, 1, 'p1', 'room', admission.playerId);
    manager.onConnect(owner);

    return { manager, owner, emojis, get directoryChanges() { return directoryChanges; }, setNow(value: number) { now = value; } };
}

test('room-directory-visible mutations notify the single publisher hook', () => {
    const fixture = managerFixture();
    assert.equal(fixture.directoryChanges, 2, 'creation and ALLOCATING→WAITING both notify');

    const reservation = seat(2);
    assert.equal(fixture.manager.reserveJoin(reservation, null).ok, true);
    assert.equal(fixture.directoryChanges, 3, 'seat reservation changes the projected count');
    assert.notEqual(fixture.manager.admitReservation(reservation), null);
    assert.equal(fixture.directoryChanges, 4, 'seat admission notifies');
    assert.equal(fixture.manager.releaseSeat('room', 2).ok, true);
    assert.equal(fixture.directoryChanges, 5, 'seat release notifies');

    fixture.manager.onJson(fixture.owner, {
        v: JSON_MESSAGE_VERSION, type: 'lobby.setLocked', requestId: 1, payload: { locked: true },
    });
    assert.equal(fixture.directoryChanges, 6, 'lock changes notify');
});

function startFixtureGame(fixture: ReturnType<typeof managerFixture>): FakeConnection[] {
    const connections = [fixture.owner];
    for (const userId of [2, 3]) {
        const reservation = seat(userId);
        assert.equal(fixture.manager.reserveJoin(reservation, null).ok, true);
        const admission = fixture.manager.admitReservation(reservation)!;
        const connection = new FakeConnection(userId, userId, `p${userId}`, 'room', admission.playerId);
        fixture.manager.onConnect(connection);
        connections.push(connection);
    }
    fixture.manager.onJson(fixture.owner, {
        v: JSON_MESSAGE_VERSION,
        type: 'lobby.start',
        requestId: 1,
        payload: {},
    });
    fixture.manager.sweep(0);
    assert.equal(fixture.manager.get('room')?.state, RoomState.Playing);
    return connections;
}

test('lobby.setLoadout accepts one loadout skill and broadcasts it', () => {
    const fixture = managerFixture();
    fixture.owner.messages.length = 0;

    fixture.manager.onJson(fixture.owner, loadoutMessage([SkillId.Flash]));

    assert.equal(fixture.manager.get('room')?.memberByUser(1)?.loadout, SkillId.Flash);
    const state = fixture.owner.messages.at(-1);
    assert.equal(state?.type, 'lobby.state');
    if (state?.type === 'lobby.state') {
        assert.equal(state.payload.roomName, 'name');
        assert.deepEqual(state.payload.players[0]?.skills, [SkillId.Flash]);
    }
});

test('lobby.setLoadout rejects an unknown skill', () => {
    const fixture = managerFixture();
    fixture.manager.onJson(fixture.owner, loadoutMessage(['unknown']));
    assert.equal(errorCode(fixture.owner), ErrorCode.InvalidPayload);
});

test('lobby.setLoadout rejects switch', () => {
    const fixture = managerFixture();
    fixture.manager.onJson(fixture.owner, loadoutMessage([SkillId.Switch]));
    assert.equal(errorCode(fixture.owner), ErrorCode.InvalidPayload);
});

test('lobby.setLoadout rejects arrays whose length is not one', () => {
    const fixture = managerFixture();
    fixture.manager.onJson(fixture.owner, loadoutMessage([SkillId.Dash, SkillId.Flash]));
    assert.equal(errorCode(fixture.owner), ErrorCode.InvalidPayload);
});

test('lobby.setLoadout rejects players and spectators once the game is playing', () => {
    const fixture = managerFixture();
    const [, spectator] = startFixtureGame(fixture);
    fixture.manager.onJson(fixture.owner, loadoutMessage([SkillId.Exhaust]));
    assert.equal(errorCode(fixture.owner), ErrorCode.BadState);

    fixture.manager.get('room')?.markEliminated(spectator!.playerId, fixture.owner.playerId);
    fixture.manager.onJson(spectator!, loadoutMessage([SkillId.Exhaust]));
    assert.equal(errorCode(spectator!), ErrorCode.BadState);
});

test('game.emoji forwards an in-game player request to the emoji state sink', () => {
    const fixture = managerFixture();
    startFixtureGame(fixture);
    fixture.manager.onJson(fixture.owner, {
        v: JSON_MESSAGE_VERSION,
        type: 'game.emoji',
        requestId: 5,
        payload: { emojiId: 7 },
    });
    assert.deepEqual(fixture.emojis, [{ playerId: fixture.owner.playerId, emojiId: 7 }]);
});

test('game.emoji rejects values that cannot fit SnapshotPlayer emojiId', () => {
    const fixture = managerFixture();
    startFixtureGame(fixture);
    fixture.manager.onJson(fixture.owner, {
        v: JSON_MESSAGE_VERSION,
        type: 'game.emoji',
        requestId: 6,
        payload: { emojiId: 256 },
    });
    assert.equal(errorCode(fixture.owner), ErrorCode.InvalidPayload);
    assert.deepEqual(fixture.emojis, []);
});

test('RoomManager가 티켓 admission과 GameTransport handler 경계를 연결한다', async () => {
    let now = 0;
    const violations: ViolationSignal[] = [];
    let resumed = false;
    const manager = new RoomManager({
        lifecycle,
        isKnownMap: (mapId) => mapId === 'map',
        getServerTick: () => 7,
        violationSink: (signal) => violations.push(signal),
        onResume: () => { resumed = true; },
        now: () => now,
    });
    const owner = seat(1);
    const created = manager.createRoom({
        id: 'room', roomCode: 'ABC234', matchId: 'match', name: 'name', password: null, capacity: 8, mapId: 'map', ownerReservation: owner,
    });
    assert.equal(created.ok, true);
    const admission = manager.admitReservation(owner)!;
    assert.equal(admission.roomState, 'WAITING', 'owner claim 시 ALLOCATING을 벗어나야 auth.ok가 최신 상태를 담는다');
    const connection = new FakeConnection(1, 1, 'p1', 'room', admission.playerId);
    manager.onConnect(connection);

    manager.onInput(connection, encodeInput({
        sequence: 1,
        left: (MovementBits.Left & 1) !== 0,
        right: false,
        up: false,
        down: false,
        heldActions: 0,
    }));
    assert.equal(violations[0]?.kind, 'BAD_STATE');

    manager.onJson(connection, {
        v: JSON_MESSAGE_VERSION,
        type: 'ping',
        requestId: 1,
        payload: { clientTime: 123 },
    });
    assert.equal(connection.messages.at(-1)?.type, 'pong');

    manager.onDisconnect(connection, 'network');
    const resume = seat(1, true);
    const reserved = manager.reserveResume(resume);
    assert.equal(reserved.ok, true);
    const resumeAdmission = manager.admitReservation(resume)!;
    const resumedConnection = new FakeConnection(2, 1, 'p1', 'room', resumeAdmission.playerId, true);
    manager.onConnect(resumedConnection);
    await Promise.resolve();
    assert.equal(resumed, true);

    now = 20_000;
    assert.deepEqual(manager.sweep(), [], '재접속한 참가자의 이전 grace timer는 제거된다');
});
