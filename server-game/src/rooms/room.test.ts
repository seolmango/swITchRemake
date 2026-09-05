import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ErrorCode, PlayerRole, RoomState, SkillId, SkillRejection, type InputState , RoomMode } from 'shared';
import type { SeatReservation } from '../gateway/ticket-store';
import type { Connection } from '../transport/game-transport';
import { Room, type RoomLifecyclePort, type RoomOptions, type RoomStartSnapshot } from './room';

class FakeConnection implements Connection {
    readonly messages: Parameters<Connection['sendJson']>[0][] = [];
    readonly binaries: ArrayBuffer[] = [];
    readonly closes: { code: number; reason: string }[] = [];
    readonly lobbyStats = null;

    public constructor(
        readonly id: number,
        readonly userId: number | string,
        readonly nickname: string,
        readonly roomId: string,
        readonly playerId: number,
        readonly resume = false,
        readonly isGuest = false,
    ) {}

    public sendJson(message: Parameters<Connection['sendJson']>[0]): void { this.messages.push(message); }
    public sendBinary(payload: ArrayBuffer): void { this.binaries.push(payload); }
    public bufferedBytes(): number { return 0; }
    public close(code: number, reason: string): void { this.closes.push({ code, reason }); }
}

class FakeLifecycle implements RoomLifecyclePort {
    readonly starts: RoomStartSnapshot[] = [];
    readonly connections: { playerId: number; connected: boolean }[] = [];
    readonly disconnects: number[] = [];
    readonly removals: { playerId: number; reason: string }[] = [];

    public startGame(snapshot: RoomStartSnapshot) {
        this.starts.push(snapshot);
        return { startTick: 200, taggerId: snapshot.players[0]!.playerId };
    }
    public connectionChanged(_roomId: string, playerId: number, connected: boolean): void {
        this.connections.push({ playerId, connected });
    }
    public participantDisconnected(_roomId: string, playerId: number): void { this.disconnects.push(playerId); }
    public participantRemoved(_roomId: string, playerId: number, reason: string): void {
        this.removals.push({ playerId, reason });
    }
    public stopRoom(_roomId: string): void {}
}

function seat(userId: number, now: number, resume = false): SeatReservation {
    return {
        userId,
        nickname: `p${userId}`,
        lobbyStats: { games: userId, wins: 0, winRate: 0, switchSuccessRate: 0 },
        roomId: 'room-1',
        serverId: 'game-1',
        issuedAt: now,
        expiresAt: now + 15_000,
        resume,
    };
}

function setup(overrides: Partial<RoomOptions> = {}, mode: RoomMode = RoomMode.Match) {
    let now = 0;
    let tick = 10;
    const lifecycle = new FakeLifecycle();
    const owner = seat(1, now);
    const options: RoomOptions = {
        id: 'room-1',
        roomCode: 'ABC234',
        matchId: 'match-1',
        name: 'test',
        password: 'secret',
        capacity: 8,
        mapId: 'map-a',
        ownerReservation: owner,
        mode,
        minPlayersToStart: mode === RoomMode.Training ? 1 : 3,
        simulationHz: 60,
        rules: { rulesVersion: 'test' },
        hudGameplay: { cooldownMs: 123 },
        timing: {
            countdownMs: 3_000,
            postGameMs: 10_000,
            reconnectGraceMs: 5_000,
            startLockOnJoinMs: 5_000,
            startLockOnMapChangeMs: 10_000,
            startLockJoinBudgetMs: 15_000,
            startLockJoinBudgetWindowMs: 60_000,
        },
        lifecycle,
        isKnownMap: (mapId) => mapId === 'map-a' || mapId === 'map-b',
        getServerTick: () => tick,
        now: () => now,
    };
    const room = new Room({ ...options, ...overrides });
    const connect = (reservation: SeatReservation) => {
        const admission = room.admitReservation(reservation)!;
        const connection = new FakeConnection(
            reservation.userId as number,
            reservation.userId,
            reservation.nickname,
            reservation.roomId,
            admission.playerId,
            reservation.resume,
        );
        assert.equal(room.bindConnection(connection), true);
        return connection;
    };
    return {
        room,
        owner,
        lifecycle,
        connect,
        setNow(value: number) { now = value; },
        setTick(value: number) { tick = value; },
        getNow() { return now; },
    };
}

test('ALLOCATING부터 POST_GAME 복귀까지 명단과 관전 자격을 서버가 관리한다', async () => {
    const context = setup();
    const c1 = context.connect(context.owner);
    assert.equal(context.room.state, RoomState.Waiting);

    const r2 = seat(2, 0);
    const r3 = seat(3, 0);
    assert.equal(context.room.reserveJoin(r2, 'secret'), null);
    assert.equal(context.room.reserveJoin(r3, 'secret'), null);
    const c2 = context.connect(r2);
    context.connect(r3);
    await Promise.resolve();

    assert.equal(context.room.setLoadout(2, SkillId.Flash), null);

    assert.equal(context.room.requestStart(1), ErrorCode.StartLocked);
    context.setNow(5_001);
    assert.equal(context.room.requestStart(1), null);
    assert.equal(context.room.state, RoomState.Countdown);
    assert.equal(context.room.reserveJoin(seat(4, 5_001), 'secret'), 'ROOM_LOCKED');

    context.setNow(8_001);
    context.room.advance();
    assert.equal(context.room.state, RoomState.Playing);
    assert.deepEqual(context.lifecycle.starts[0]?.players.map((player) => player.playerId), [1, 2, 3]);
    assert.equal(context.lifecycle.starts[0]?.players.find((player) => player.playerId === 2)?.loadout, SkillId.Flash);
    assert.equal(context.room.snapshotAccess(1), 'filtered');
    assert.equal(context.room.setSpectating(1, true), ErrorCode.SpectateDenied, '살아 있는 플레이어는 관전할 수 없다');

    assert.equal(context.room.markEliminated(2, 1), true);
    assert.equal(context.room.snapshotAccess(2), 'unfiltered');
    assert.equal(context.room.setSpectating(2, false), null);
    assert.equal(context.room.snapshotAccess(2), 'none', '대기실로 돌아가면 스냅샷을 받지 않는다');
    assert.equal(context.room.setSpectating(2, true), null);

    assert.equal(c2.messages.some((message) => message.type === 'player.eliminated'), true);
    assert.equal(context.room.finishGame([1, 3]), true);
    assert.equal(context.room.state, RoomState.PostGame);
    context.setNow(18_001);
    context.room.advance();
    assert.equal(context.room.state, RoomState.Waiting);
    assert.equal(context.room.memberByUser(2)?.role, PlayerRole.Player);
    assert.equal(c1.closes.length, 0);
});

test('재경기는 매칭 서버가 발급한 다음 경기 id로만 시작한다', async () => {
    const { context } = await playingRoom();
    assert.equal(context.room.finishGame([1, 3]), true);
    context.setNow(context.getNow() + 10_001);
    context.room.advance();
    assert.equal(context.room.state, RoomState.Waiting);

    // 결과가 아직 저장되지 않아 발급이 안 왔다. 영구 거절이 아니라 "잠시 뒤 다시"다.
    assert.equal(context.room.requestStart(1), ErrorCode.ResultBacklog);
    assert.equal(context.lifecycle.starts.length, 1);

    context.room.grantMatchId('match-2');
    assert.equal(context.room.requestStart(1), null);
    context.setNow(context.getNow() + 8_001);
    context.room.advance();
    assert.equal(context.room.state, RoomState.Playing);
    assert.equal(context.lifecycle.starts.length, 2);
    assert.equal(context.lifecycle.starts[1]?.matchId, 'match-2', '발급받은 id를 그대로 쓴다');

    // 한 번 쓴 발급은 소모된다. 같은 id로 두 경기를 치를 수 없다.
    assert.equal(context.room.finishGame([1, 3]), true);
    context.setNow(context.getNow() + 10_001);
    context.room.advance();
    assert.equal(context.room.state, RoomState.Waiting);
    assert.equal(context.room.requestStart(1), ErrorCode.ResultBacklog);
});

test('경기 종료 메시지는 한 명 승자를 그대로 보내고 승자 계약을 경계에서 검증한다', async () => {
    const { context, c2 } = await playingRoom();

    assert.throws(() => context.room.finishGame([]), /invalid winner ids/);
    assert.throws(() => context.room.finishGame([1, 1]), /invalid winner ids/);
    assert.throws(() => context.room.finishGame([9]), /invalid winner ids/);
    assert.equal(context.room.state, RoomState.Playing, '잘못된 결과로 방 상태를 바꾸면 안 된다');

    assert.equal(context.room.finishGame([1]), true);
    const ended = c2.messages.find((message) => message.type === 'game.ended');
    assert.deepEqual(ended?.payload.winnerIds, [1]);
});

test('좌표를 싣는 연출은 시전자를 보는 사람에게만 간다', async () => {
    const context = setup();
    const c1 = context.connect(context.owner);
    const r2 = seat(2, 0);
    const r3 = seat(3, 0);
    assert.equal(context.room.reserveJoin(r2, 'secret'), null);
    assert.equal(context.room.reserveJoin(r3, 'secret'), null);
    const c2 = context.connect(r2);
    const c3 = context.connect(r3);
    await Promise.resolve();
    context.setNow(5_001);
    assert.equal(context.room.requestStart(1), null);
    context.setNow(8_001);
    context.room.advance();
    assert.equal(context.room.state, RoomState.Playing);

    // 3번만 1번을 본다. 시야 판정 자체는 시뮬레이션이 하고 방은 그 결과를 받는다.
    context.room.broadcastBlinked(1, 10, 20, (viewerPlayerId) => viewerPlayerId === 3);
    const blinked = (connection: FakeConnection) => connection.messages.filter((m) => m.type === 'player.blinked');
    assert.equal(blinked(c1).length, 1, '시전자 본인은 언제나 받는다');
    assert.equal(blinked(c2).length, 0, '못 보는 사람에게 좌표가 가면 스냅샷 검열이 무의미해진다');
    assert.equal(blinked(c3).length, 1);

    // 관전자는 전부 본다. 스냅샷과 같은 등급 판정을 쓴다.
    assert.equal(context.room.markEliminated(2, 1), true);
    assert.equal(context.room.snapshotAccess(2), 'unfiltered');
    context.room.broadcastSkillArea('SWITCH', 1, 10, 20, null, () => false);
    assert.equal(c2.messages.filter((m) => m.type === 'player.skillArea').length, 1);
    assert.equal(c3.messages.filter((m) => m.type === 'player.skillArea').length, 0);
});

test('skill.rejected is sent only to the requesting player', () => {
    const context = setup();
    const c1 = context.connect(context.owner);
    const r2 = seat(2, 0);
    context.room.reserveJoin(r2, 'secret');
    const c2 = context.connect(r2);

    context.room.sendSkillRejected(1, 2, SkillRejection.OutOfRange);

    assert.deepEqual(c1.messages.filter((message) => message.type === 'skill.rejected'), [{
        type: 'skill.rejected',
        payload: { slot: 2, reason: SkillRejection.OutOfRange },
    }]);
    assert.equal(c2.messages.some((message) => message.type === 'skill.rejected'), false);
});

test('disconnect 즉시 입력을 중립화하고 탈락시킨 뒤 같은 자리를 관전자로 복구한다', () => {
    const context = setup();
    const c1 = context.connect(context.owner);
    const r2 = seat(2, 0);
    const r3 = seat(3, 0);
    context.room.reserveJoin(r2, 'secret');
    context.room.reserveJoin(r3, 'secret');
    context.connect(r2);
    context.connect(r3);
    context.setNow(5_001);
    context.room.requestStart(1);
    context.setNow(8_001);
    context.room.advance();

    const input = (sequence: number, right: boolean): InputState => ({
        sequence, left: false, right, up: false, down: false, heldActions: 3,
    });
    assert.equal(context.room.acceptInput(c1, input(65_535, true)), true);
    assert.equal(context.room.acceptInput(c1, input(0, true)), true, 'u16 wrap 이후 입력이 최신이다');
    assert.equal(context.room.acceptInput(c1, input(65_534, false)), false, '과거 입력은 무시한다');
    assert.equal(context.room.resolvedInputs()[0]?.lastProcessedSequence, 0);

    context.room.disconnect(c1, 'network');
    assert.equal(context.room.resolvedInputs().some((value) => value.playerId === 1), false);
    assert.deepEqual(context.lifecycle.connections.at(-1), { playerId: 1, connected: false });
    assert.deepEqual(context.lifecycle.disconnects, [1]);
    assert.equal(context.room.memberByUser(1)?.role, PlayerRole.Spectator);

    const resume = seat(1, context.getNow(), true);
    assert.equal(context.room.canReserveResume(1), null);
    const admission = context.room.admitReservation(resume)!;
    assert.equal(admission.playerId, 1);
    const resumed = new FakeConnection(99, 1, 'p1', 'room-1', 1, true);
    assert.equal(context.room.bindConnection(resumed), true);
    assert.equal(context.room.acceptInput(resumed, input(1, true)), false);
    assert.equal(context.room.snapshotAccess(1), 'unfiltered', '그 경기에서 탈락했으므로 관전으로 돌아와야 한다');
});

test('재접속 유예 5초가 끝나면 이미 탈락한 참가자의 slot을 해제한다', () => {
    const context = setup();
    const c1 = context.connect(context.owner);
    const r2 = seat(2, 0);
    context.room.reserveJoin(r2, 'secret');
    const c2 = context.connect(r2);
    context.room.disconnect(c1, 'network');

    context.setNow(5_001);
    context.room.advance();
    assert.equal(context.room.memberByUser(1), null);
    assert.deepEqual(context.lifecycle.disconnects, [], '대기실 연결 종료는 경기 탈락이 아니다');
    assert.equal(context.room.hostId, 2);
    assert.equal(c2.messages.some((message) => message.type === 'lobby.hostChanged'), true);
});

test('resume admission만 받고 연결이 완성되지 않으면 5초 뒤 자리를 놓는다', () => {
    const context = setup();
    const c1 = context.connect(context.owner);
    const r2 = seat(2, 0);
    context.room.reserveJoin(r2, 'secret');
    context.connect(r2);
    context.room.disconnect(c1, 'network');

    const shortResume = { ...seat(1, 0, true), expiresAt: 1_000 };
    assert.notEqual(context.room.admitReservation(shortResume), null);
    context.setNow(5_001);
    context.room.advance();
    assert.equal(context.room.memberByUser(1), null, '인증 시도만으로 자리 보존이 5초를 넘으면 안 된다');
    assert.notEqual(context.room.canReserveResume(1), null);
});

test('강퇴한 사용자는 방이 살아 있는 동안 다시 예약할 수 없다', () => {
    const context = setup();
    context.connect(context.owner);
    const r2 = seat(2, 0);
    context.room.reserveJoin(r2, 'secret');
    const c2 = context.connect(r2);
    assert.equal(context.room.kick(1, 2), null);
    assert.equal(c2.closes[0]?.code, 1008);
    assert.equal(context.room.reserveJoin(seat(2, 1), 'secret'), 'KICKED_FROM_ROOM');
});

test('훈련장 부활은 관전자를 다시 플레이어로 돌린다', () => {
    // 시뮬레이션의 alive만 되돌리면 resolvedInputs가 관전자 입력을 버려서
    // 화면에는 살아 있는데 움직이지 않는 상태가 된다.
    const context = setup({}, RoomMode.Training);
    context.connect(context.owner);
    const second = seat(2, 0);
    assert.equal(context.room.reserveJoin(second, 'secret'), null);
    context.connect(second);
    context.setNow(6_000);  // 참가 잠금(5초)이 풀린 뒤
    assert.equal(context.room.requestStart(1), null);
    context.setNow(10_000);
    context.room.advance();
    assert.equal(context.room.state, RoomState.Playing);

    assert.equal(context.room.markEliminated(2, 1), true);
    const member = context.room.memberByUser(2)!;
    assert.equal(member.spectatorEligible, true);

    assert.equal(context.room.reviveForTraining(2), true);
    assert.equal(member.spectatorEligible, false);
    assert.equal(member.role, PlayerRole.Player);
    assert.equal(context.room.reviveForTraining(2), false, '살아 있는데 또 되살아났다');
});

test('경기 방에서는 훈련장 부활이 거부된다', () => {
    const context = setup();
    context.connect(context.owner);
    assert.equal(context.room.reviveForTraining(1), false);
});

test('lobby.state는 자리 예약에 실려 온 전적을 그대로 돌려준다', () => {
    const context = setup();
    const connection = context.connect(context.owner);
    context.room.broadcastLobbyState();

    const lobby = connection.messages.filter((message) => message.type === 'lobby.state').at(-1);
    assert.notEqual(lobby, undefined);
    assert.deepEqual(lobby?.payload.players[0]?.stats, context.owner.lobbyStats);
});

test('전적 없이 예약한 사람(게스트)은 lobby.state에서도 null이다', () => {
    const context = setup();
    context.connect(context.owner);
    const guest: SeatReservation = { ...seat(2, context.getNow()), lobbyStats: null };
    assert.equal(context.room.reserveJoin(guest, 'secret'), null);
    const connection = context.connect(guest);
    context.room.broadcastLobbyState();

    const lobby = connection.messages.filter((message) => message.type === 'lobby.state').at(-1);
    const seen = lobby?.payload.players.find((player) => player.nickname === guest.nickname);
    assert.equal(seen?.stats, null);
});

test('결과를 내보낼 자리가 없으면 새 경기를 시작하지 않는다', () => {
    // outbox가 가득 찬 채로 경기를 시작하면 끝나는 순간 전적이 조용히 사라진다.
    // 거절하는 쪽이 낫다 — 사람이 다시 누를 수 있고, outbox는 Redis가 살아나면 비워진다.
    let outboxHasRoom = false;
    const context = setup({ canStartGame: () => outboxHasRoom });
    context.connect(context.owner);
    const r2 = seat(2, 0);
    const r3 = seat(3, 0);
    assert.equal(context.room.reserveJoin(r2, 'secret'), null);
    assert.equal(context.room.reserveJoin(r3, 'secret'), null);
    context.connect(r2);
    context.connect(r3);
    context.setNow(5_001);

    assert.equal(context.room.requestStart(1), ErrorCode.ResultBacklog);
    assert.equal(context.room.state, RoomState.Waiting);

    outboxHasRoom = true;
    assert.equal(context.room.requestStart(1), null);
    assert.equal(context.room.state, RoomState.Countdown);
});

/** 경기가 돌고 있는 방을 만들고, 그 방에 재접속할 자리를 하나 비워 둔다. */
async function playingRoom() {
    const context = setup();
    context.connect(context.owner);
    const r2 = seat(2, 0);
    const r3 = seat(3, 0);
    assert.equal(context.room.reserveJoin(r2, 'secret'), null);
    assert.equal(context.room.reserveJoin(r3, 'secret'), null);
    const c2 = context.connect(r2);
    context.connect(r3);
    await Promise.resolve();
    context.setNow(5_001);
    assert.equal(context.room.requestStart(1), null);
    context.setNow(8_001);
    context.room.advance();
    assert.equal(context.room.state, RoomState.Playing);
    return { context, c2 };
}

test('경기 중 참가자는 Waiting으로 들어와 게임 상태를 받지 않고 다음 경기부터 참가한다', async () => {
    const { context } = await playingRoom();
    const lateReservation = seat(4, context.getNow());
    assert.equal(context.room.reserveJoin(lateReservation, 'secret'), null);
    const admission = context.room.admitReservation(lateReservation)!;
    assert.equal(admission.role, PlayerRole.Waiting);
    const late = new FakeConnection(4, 4, 'p4', 'room-1', admission.playerId);
    assert.equal(context.room.bindConnection(late), true);
    await Promise.resolve();

    assert.equal(context.room.playerCount, 4, '경기 중 참가자도 방 정원을 차지한다');
    assert.equal(context.room.memberByUser(4)?.inCurrentGame, false);
    assert.equal(context.room.memberByUser(4)?.spectatorEligible, false);
    assert.equal(context.room.snapshotAccess(4), 'none');
    assert.equal(context.room.snapshotTargets().some((target) => target.playerId === 4), false);
    assert.equal(late.messages.some((message) => message.type === 'game.starting' || message.type === 'game.started'), false);

    context.room.broadcastTagged(1, null);
    assert.equal(late.messages.some((message) => message.type === 'player.tagged'), false, '게임 이벤트도 대기자에게 보내면 안 된다');
    assert.equal(context.room.setSpectating(4, true), ErrorCode.SpectateDenied);

    assert.equal(context.room.finishGame([1, 3]), true);
    assert.equal(late.messages.some((message) => message.type === 'game.ended'), false, '참가하지 않은 경기 결과를 보내면 안 된다');
    context.setNow(context.getNow() + 10_001);
    context.room.advance();
    assert.equal(context.room.memberByUser(4)?.role, PlayerRole.Player);

    context.room.grantMatchId('match-2');
    assert.equal(context.room.requestStart(1), null);
    context.setNow(context.getNow() + 3_001);
    context.room.advance();
    assert.deepEqual(context.lifecycle.starts[1]?.players.map((player) => player.playerId), [1, 2, 3, 4]);
});

test('경기 중 참가자도 8명 정원에 포함된다', async () => {
    const { context } = await playingRoom();
    for (const userId of [4, 5, 6, 7, 8]) {
        assert.equal(context.room.reserveJoin(seat(userId, context.getNow()), 'secret'), null);
    }
    assert.equal(context.room.occupiedCount, 8);
    assert.equal(context.room.reserveJoin(seat(9, context.getNow()), 'secret'), 'ROOM_FULL');
});

test('유예 만료로 빈 번호라도 현재 경기 명단이 쓰는 동안에는 새 참가자에게 배정하지 않는다', () => {
    const context = setup();
    context.connect(context.owner);
    const reservations = [2, 3, 4].map((userId) => seat(userId, 0));
    for (const reservation of reservations) {
        assert.equal(context.room.reserveJoin(reservation, 'secret'), null);
    }
    const second = context.connect(reservations[0]!);
    context.connect(reservations[1]!);
    context.connect(reservations[2]!);
    context.setNow(5_001);
    assert.equal(context.room.requestStart(1), null);
    context.setNow(8_001);
    context.room.advance();

    context.room.disconnect(second, 'network');
    context.setNow(13_002);
    context.room.advance();
    assert.equal(context.room.memberByUser(2), null);

    const lateReservation = seat(5, context.getNow());
    assert.equal(context.room.reserveJoin(lateReservation, 'secret'), null);
    assert.equal(context.room.admitReservation(lateReservation)?.playerId, 5);
});

test('경기 중 끊긴 참가자가 5초 안에 돌아오면 같은 번호의 관전자로 시작 상태를 다시 받는다', async () => {
    // 두 메시지는 시작하는 순간 한 번만 나갔다. 그래서 경기 도중에 끊겼다 돌아온 사람은
    // 방이 멀쩡히 PLAYING인데도 "경기 시작 신호를 기다리는" 화면에서 영영 멈춰 있었다.
    const { context, c2 } = await playingRoom();

    context.room.disconnect(c2, 'network');
    assert.equal(context.room.canReserveResume(2), null);
    const resumed = seat(2, context.getNow(), true);
    const admission = context.room.admitReservation(resumed)!;
    const back = new FakeConnection(99, 2, 'p2', 'room-1', admission.playerId, true);
    assert.equal(context.room.bindConnection(back), true);
    await Promise.resolve();

    assert.equal(back.playerId, c2.playerId);
    assert.equal(context.room.memberByUser(2)?.role, PlayerRole.Spectator);
    assert.equal(context.room.snapshotAccess(2), 'unfiltered');
    context.room.disconnect(c2, '늦게 도착한 이전 연결 종료');
    assert.equal(context.room.memberByUser(2)?.connection?.id, back.id, '이전 연결 종료가 새 연결을 끊으면 안 된다');

    const starting = back.messages.find((message) => message.type === 'game.starting');
    const started = back.messages.find((message) => message.type === 'game.started');
    assert.notEqual(starting, undefined, 'gameplay 수치가 여기에만 실려 있어 못 받으면 쿨타임·사거리가 죽는다');
    assert.notEqual(started, undefined);
    // 순서가 뒤집히면 클라이언트가 Countdown에 멈춰 선다.
    assert.ok(
        back.messages.indexOf(starting!) < back.messages.indexOf(started!),
        'game.starting이 game.started보다 먼저 가야 한다',
    );
    // 카운트다운은 이미 끝났다. 남은 시간인 척하는 값을 보내면 언젠가 그걸 읽는 화면이 틀린다.
    assert.equal(starting?.payload.countdownMs, 0);
    assert.ok(Object.keys(starting?.payload.gameplay ?? {}).length > 0);
});

test('경기가 끝난 뒤에 들어온 사람에게는 다시 알리지 않는다', async () => {
    // 끝난 경기를 시작했다고 알리면 결과 화면 대신 빈 경기 화면에 들어앉는다.
    const { context, c2 } = await playingRoom();
    assert.equal(context.room.finishGame([1, 3]), true);

    context.room.disconnect(c2, 'network');
    assert.equal(context.room.canReserveResume(2), null);
    const resumed = seat(2, context.getNow(), true);
    const back = context.connect(resumed);
    await Promise.resolve();

    assert.equal(back.messages.some((message) => message.type === 'game.starting'), false);
    assert.equal(back.messages.some((message) => message.type === 'game.started'), false);
});

test('카운트다운 중에 재접속하면 game.starting만 받는다', async () => {
    // 아직 시작하지 않았으므로 started는 없다. 그래도 gameplay는 지금 줘야 카운트다운이 끝나는
    // 순간 화면이 준비돼 있다.
    const context = setup();
    context.connect(context.owner);
    const r2 = seat(2, 0);
    const r3 = seat(3, 0);
    assert.equal(context.room.reserveJoin(r2, 'secret'), null);
    assert.equal(context.room.reserveJoin(r3, 'secret'), null);
    const c2 = context.connect(r2);
    context.connect(r3);
    await Promise.resolve();
    context.setNow(5_001);
    assert.equal(context.room.requestStart(1), null);
    assert.equal(context.room.state, RoomState.Countdown);

    context.room.disconnect(c2, 'network');
    assert.equal(context.room.canReserveResume(2), null);
    const resumed = seat(2, context.getNow(), true);
    const back = context.connect(resumed);
    await Promise.resolve();

    const starting = back.messages.find((message) => message.type === 'game.starting');
    assert.notEqual(starting, undefined);
    // 카운트다운이 실제로 남아 있으므로 0으로 덮지 않는다.
    assert.ok((starting?.payload.countdownMs ?? 0) > 0);
    assert.equal(back.messages.some((message) => message.type === 'game.started'), false);
});

test('넘길 방의 사본에 명단과 방장이 그대로 담긴다', async () => {
    // 소켓은 프로세스에 붙은 TCP 연결이라 옮길 수 없다. 그래서 받는 쪽은 이 사람들을
    // "끊겼지만 유예 안에 있는" 상태로 세우고, 클라이언트의 기존 재접속 경로가 그대로 통한다.
    const source = setup();
    source.connect(source.owner);
    const r2 = seat(2, 0);
    assert.equal(source.room.reserveJoin(r2, 'secret'), null);
    source.connect(r2);
    await Promise.resolve();

    assert.equal(source.room.canHandOff(), true);
    const exported = source.room.exportForHandOff('game-2');
    assert.equal(exported.serverId, 'game-2');
    assert.equal(exported.roomId, source.room.id);
    assert.deepEqual(exported.members.map((member) => member.playerId).sort(), [1, 2]);
    assert.equal(exported.members.filter((member) => member.isHost).length, 1, '방장이 정확히 하나여야 한다');
    assert.equal(exported.members.find((member) => member.playerId === 2)?.nickname, 'p2');
});

test('경기 중인 방은 넘기지 않는다', () => {
    // 옮기려면 세계 전체를 직렬화해야 한다. 그 위험을 감수할 이유가 없다.
    const context = setup();
    context.connect(context.owner);
    const r2 = seat(2, 0);
    const r3 = seat(3, 0);
    assert.equal(context.room.reserveJoin(r2, 'secret'), null);
    assert.equal(context.room.reserveJoin(r3, 'secret'), null);
    context.connect(r2);
    context.connect(r3);
    context.setNow(5_001);
    assert.equal(context.room.requestStart(1), null);
    assert.equal(context.room.canHandOff(), false, '카운트다운 중에 넘기려 한다');

    context.setNow(8_001);
    context.room.advance();
    assert.equal(context.room.state, RoomState.Playing);
    assert.equal(context.room.canHandOff(), false, '경기 중에 넘기려 한다');
});

test('아무도 안 붙어 있는 방은 넘기지 않는다', () => {
    // 곧 스스로 닫힐 방이라 옮길 값이 없다.
    const context = setup();
    assert.equal(context.room.canHandOff(), false);
});



test('경기 중에는 즉시 탈락하고 5초가 지나면 자리와 재접속 권한을 함께 놓는다', async () => {
    const { context, c2 } = await playingRoom();
    context.room.disconnect(c2, 'network');

    assert.deepEqual(context.lifecycle.disconnects, [2], '유예 만료까지 탈락을 미루면 안 된다');
    assert.equal(context.room.memberByUser(2)?.role, PlayerRole.Spectator);

    context.setNow(context.getNow() + 5_001);
    context.room.advance();

    assert.equal(context.room.memberByUser(2), null);
    assert.notEqual(context.room.canReserveResume(2), null);
});

test('대기실에서 유예가 끝나면 예전처럼 자리를 놓는다', () => {
    // 대기실 자리는 붙들 이유가 없다. 붙들면 그 방은 영영 안 찬다.
    const context = setup();
    const c1 = context.connect(context.owner);
    const r2 = seat(2, 0);
    context.room.reserveJoin(r2, 'secret');
    context.connect(r2);
    context.room.disconnect(c1, 'network');

    context.setNow(5_001);
    context.room.advance();
    assert.equal(context.room.memberByUser(1), null);
    assert.notEqual(context.room.canReserveResume(1), null);
});
