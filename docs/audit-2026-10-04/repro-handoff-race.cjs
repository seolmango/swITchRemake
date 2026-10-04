'use strict';
// One bounded, in-memory control-plane interleaving. No network or credentials.
const { RoomManager } = require('../../server-game/dist-test/rooms/room-manager');
const { handOffWaitingRooms } = require('../../server-game/dist-test/rooms/hand-off');
const { makeKeys, PROTOCOL_VERSION } = require('shared');
let starts = 0;
let draining = false;
const rooms = new RoomManager({
    lifecycle: { startGame: () => { starts++; return { startTick: 0, taggerId: 1 }; },
        connectionChanged() {}, participantDisconnected() {}, participantRemoved() {}, stopRoom() {} },
    isKnownMap: () => true, getServerTick: () => 0, violationSink() {}, now: () => 0,
    isDraining: () => draining,
    timing: { countdownMs: 0, startLockOnJoinMs: 0, startLockOnMapChangeMs: 0 },
});
const reservation = userId => ({ userId, nickname: `synthetic-${userId}`, lobbyStats: null,
    roomId: 'synthetic-room', serverId: 'source', issuedAt: 0, expiresAt: 15000, resume: false });
rooms.createRoom({ id: 'synthetic-room', roomCode: 'ABC234', matchId: 'synthetic-match',
    name: 'audit', password: null, capacity: 3, mapId: 'audit', ownerReservation: reservation(1) });
const room = rooms.get('synthetic-room');
for (const userId of [1, 2, 3]) {
    const seat = reservation(userId);
    if (userId !== 1) rooms.reserveJoin(seat, null);
    const admitted = rooms.admitReservation(seat);
    rooms.onConnect({ id: userId, userId, playerId: admitted.playerId, roomId: seat.roomId,
        nickname: seat.nickname, resume: false, isGuest: false, lobbyStats: null,
        sendJson() {}, sendBinary() {}, bufferedBytes: () => 0, close() {} });
}
let directoryOwner = 'source';
let startAccepted;
const keys = makeKeys('audit');
const redis = {
    zRange: async () => ['source', 'peer'],
    get: async key => key === keys.gameServer('peer')
        ? JSON.stringify({ serverId: 'peer', protocolVersion: PROTOCOL_VERSION,
            waitingRooms: 0, playingRooms: 0, draining: false })
        : JSON.stringify({ serverId: directoryOwner }),
    xAdd: async () => {
        // Emulate a host action during the awaited Redis command send.
        startAccepted = room.requestStart(1) === null;
        rooms.sweep();
        directoryOwner = 'peer';
        return '1-0';
    },
};
const timeout = setTimeout(() => { console.error('bounded reproduction timed out'); process.exitCode = 1; }, 1000);
draining = true;
handOffWaitingRooms({ redis, keys, rooms, serverId: 'source', forgetRoom() {}, log() {},
    confirmTries: 1, confirmIntervalMs: 1 }).then(moved => {
    clearTimeout(timeout);
    console.log(JSON.stringify({ startAcceptedDuringTransfer: startAccepted, startedSessions: starts,
        movedRooms: moved, finalSourceState: room.state, defectReproduced: startAccepted && starts === 1 && moved === 1 }));
}).catch(error => { clearTimeout(timeout); console.error(error.name); process.exitCode = 1; });
