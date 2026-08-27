import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    EMOJI_ID_MAX,
    EMOJI_ID_MIN,
    encodeInput,
    ErrorCode,
    JSON_MESSAGE_VERSION,
    MovementBits,
    RoomMode,
    RoomState,
    SkillId,
    type AdoptRoomPayload,
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
        stopRoom: () => undefined,
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

function slotMessage(slot: number): ClientMessage {
    return {
        v: JSON_MESSAGE_VERSION,
        type: 'lobby.setSlot',
        requestId: 43,
        payload: { slot },
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

test('lobby.setSlot changes the roster slot and rejects invalid waiting-room moves', () => {
    const fixture = managerFixture();
    fixture.owner.messages.length = 0;

    fixture.manager.onJson(fixture.owner, slotMessage(2));
    assert.equal(fixture.manager.get('room')?.memberByUser(1)?.slot, 2);
    const state = fixture.owner.messages.at(-1);
    assert.equal(state?.type, 'lobby.state');
    if (state?.type === 'lobby.state') assert.equal(state.payload.players[0]?.slot, 2);

    fixture.manager.onJson(fixture.owner, slotMessage(9));
    assert.equal(errorCode(fixture.owner), ErrorCode.InvalidPayload);

    const reservation = seat(2);
    assert.equal(fixture.manager.reserveJoin(reservation, null).ok, true);
    const admission = fixture.manager.admitReservation(reservation)!;
    const peer = new FakeConnection(2, 2, 'p2', 'room', admission.playerId);
    fixture.manager.onConnect(peer);
    fixture.manager.onJson(fixture.owner, slotMessage(1));
    assert.equal(errorCode(fixture.owner), ErrorCode.BadState);
});

test('lobby.setSlot rejects requests once the room has started', () => {
    const fixture = managerFixture();
    startFixtureGame(fixture);
    fixture.manager.onJson(fixture.owner, slotMessage(4));
    assert.equal(errorCode(fixture.owner), ErrorCode.BadState);
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

test('game.emoji는 계약 범위 밖의 번호를 거부한다', () => {
    // u8에 들어간다는 이유로 0..255를 통과시키면, 서버는 받아서 뿌리는데 남의 클라이언트에는
    // 그릴 그림이 없는 번호가 나간다. 보내는 사람만 멀쩡해 보이는 종류의 버그다.
    for (const [index, emojiId] of [256, 0, -1, EMOJI_ID_MAX + 1, 1.5].entries()) {
        const fixture = managerFixture();
        startFixtureGame(fixture);
        fixture.manager.onJson(fixture.owner, {
            v: JSON_MESSAGE_VERSION,
            type: 'game.emoji',
            requestId: 6 + index,
            payload: { emojiId },
        });
        assert.equal(errorCode(fixture.owner), ErrorCode.InvalidPayload, `emojiId=${emojiId}`);
        assert.deepEqual(fixture.emojis, [], `emojiId=${emojiId}`);
    }
});

test('game.emoji는 계약 범위의 양 끝을 통과시킨다', () => {
    for (const emojiId of [EMOJI_ID_MIN, EMOJI_ID_MAX]) {
        const fixture = managerFixture();
        startFixtureGame(fixture);
        fixture.manager.onJson(fixture.owner, {
            v: JSON_MESSAGE_VERSION,
            type: 'game.emoji',
            requestId: 20,
            payload: { emojiId },
        });
        assert.deepEqual(fixture.emojis, [{ playerId: fixture.owner.playerId, emojiId }]);
    }
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

/** 다른 서버에서 넘어온 것처럼 생긴 방 사본. */
const migrationPayload = (overrides: Partial<AdoptRoomPayload> = {}): AdoptRoomPayload => ({
    serverId: 'game-1',
    roomId: 'moved-room',
    roomCode: 'XYZ789',
    matchId: 'match-moved',
    name: '넘어온 방',
    password: null,
    capacity: 8,
    mapId: 'map',
    mode: RoomMode.Match,
    members: [
        {
            userId: 11, playerId: 1, slot: 1, nickname: 'p11', guest: false, stats: null,
            loadout: SkillId.Dash, joinedOrder: 0, colorIndex: 0, isHost: true,
        },
        {
            userId: 12, playerId: 2, slot: 2, nickname: 'p12', guest: false, stats: null,
            loadout: SkillId.Flash, joinedOrder: 1, colorIndex: 1, isHost: false,
        },
    ],
    ...overrides,
});

test('넘겨받은 방의 사람들은 재접속으로 돌아올 수 있다', () => {
    // 소켓은 프로세스에 붙은 TCP 연결이라 옮길 수 없다. 그래서 받는 쪽은 이 사람들을
    // "끊겼지만 유예 안에 있는" 상태로 세우고, 클라이언트의 기존 재접속 경로가 그대로 통한다.
    const fixture = managerFixture();
    const adopted = fixture.manager.adoptRoom(migrationPayload());
    assert.equal(adopted.ok, true);

    const room = fixture.manager.get('moved-room');
    assert.notEqual(room, null);
    assert.equal(room?.canReserveResume(11), null, '넘어온 방장이 재접속할 수 없다');
    assert.equal(room?.canReserveResume(12), null);
    assert.equal(room?.state, RoomState.Waiting);
});

test('넘겨받은 방은 방장과 로드아웃을 그대로 유지한다', () => {
    const fixture = managerFixture();
    fixture.manager.adoptRoom(migrationPayload());
    const room = fixture.manager.get('moved-room')!;

    const members = room.participants();
    assert.deepEqual(members.map((member) => member.playerId).sort(), [1, 2]);
    // 방장이 안 옮겨지면 아무도 경기를 시작할 수 없다.
    assert.equal(room.setMap(11, 'map'), null, '넘어온 방장이 방장 권한을 잃었다');
    assert.notEqual(room.setMap(12, 'map'), null, '방장이 아닌 사람이 맵을 바꿀 수 있다');
});

test('같은 방을 두 번 넘겨받지 않는다', () => {
    // 제어 명령은 재전달될 수 있다. 명단을 덮어쓰면 그 사이에 들어온 사람이 사라진다.
    const fixture = managerFixture();
    assert.equal(fixture.manager.adoptRoom(migrationPayload()).ok, true);
    assert.equal(fixture.manager.adoptRoom(migrationPayload()).ok, false);
});

test('명단이 빈 방은 넘겨받지 않는다', () => {
    // 아무도 없는 방이 서면 첫 sweep에 닫힌다. 조용히 사라지느니 거절한다.
    const fixture = managerFixture();
    assert.equal(fixture.manager.adoptRoom(migrationPayload({ members: [] })).ok, false);
});

test('모르는 맵으로는 넘겨받지 않는다', () => {
    const fixture = managerFixture();
    assert.equal(fixture.manager.adoptRoom(migrationPayload({ mapId: 'ghost' })).ok, false);
});

test('상한을 넘으면 방을 더 만들지 않는다', () => {
    // 상한이 없으면 부하 분산기가 밀어붙일 천장이 없다 — 서버가 다 터져 가도 "그나마 덜 나쁜
    // 놈"을 골라 계속 방을 꽂아넣는다. 거절할 줄 아는 것이 분산의 전제다.
    let now = 0;
    const manager = new RoomManager({
        lifecycle,
        maxRooms: 2,
        isKnownMap: (mapId) => mapId === 'map',
        getServerTick: () => 0,
        violationSink: () => undefined,
        now: () => now,
        timing: {
            reconnectGraceMs: 10_000,
            startLockOnJoinMs: 0,
            startLockOnMapChangeMs: 0,
        },
    });
    const make = (id: string, userId: number) => manager.createRoom({
        id, roomCode: 'ABC234', matchId: `m-${id}`, name: id, password: null,
        capacity: 8, mapId: 'map', ownerReservation: { ...seat(userId), roomId: id },
    });

    assert.equal(make('r1', 1).ok, true);
    assert.equal(make('r2', 2).ok, true);
    const third = make('r3', 3);
    assert.equal(third.ok, false);
    assert.equal(third.ok ? null : third.code, 'SERVER_FULL');
});
