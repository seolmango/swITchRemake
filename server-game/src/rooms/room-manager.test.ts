import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeInput, JSON_MESSAGE_VERSION, MovementBits, type ViolationSignal } from 'shared';
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
    startGame: (snapshot) => ({ startTick: 1, taggerId: snapshot.playerIds[0]! }),
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
        id: 'room', matchId: 'match', name: 'name', password: null, capacity: 8, mapId: 'map', ownerReservation: owner,
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
