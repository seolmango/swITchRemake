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
    readonly timeouts: number[] = [];
    readonly removals: { playerId: number; reason: string }[] = [];

    public startGame(snapshot: RoomStartSnapshot) {
        this.starts.push(snapshot);
        return { startTick: 200, taggerId: snapshot.players[0]!.playerId };
    }
    public connectionChanged(_roomId: string, playerId: number, connected: boolean): void {
        this.connections.push({ playerId, connected });
    }
    public participantTimedOut(_roomId: string, playerId: number): void { this.timeouts.push(playerId); }
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
            postGameMs: 30_000,
            reconnectGraceMs: 10_000,
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
    context.setNow(38_001);
    context.room.advance();
    assert.equal(context.room.state, RoomState.Waiting);
    assert.equal(context.room.memberByUser(2)?.role, PlayerRole.Player);
    assert.equal(c1.closes.length, 0);
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

test('최신 u16 sequence만 유지하고 disconnect 즉시 입력을 중립화한 뒤 같은 자리를 복구한다', () => {
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

    const resume = seat(1, context.getNow(), true);
    assert.equal(context.room.canReserveResume(1), null);
    const admission = context.room.admitReservation(resume)!;
    assert.equal(admission.playerId, 1);
    const resumed = new FakeConnection(99, 1, 'p1', 'room-1', 1, true);
    assert.equal(context.room.bindConnection(resumed), true);
    assert.equal(context.room.acceptInput(resumed, input(1, true)), true);
    assert.equal(context.room.resolvedInputs().find((value) => value.playerId === 1)?.lastProcessedSequence, 1);
});

test('재접속 유예 만료는 slot을 해제하고 시뮬레이션 경계에 알린다', () => {
    const context = setup();
    const c1 = context.connect(context.owner);
    const r2 = seat(2, 0);
    context.room.reserveJoin(r2, 'secret');
    const c2 = context.connect(r2);
    context.room.disconnect(c1, 'network');

    context.setNow(10_001);
    context.room.advance();
    assert.equal(context.room.memberByUser(1), null);
    assert.deepEqual(context.lifecycle.timeouts, [1]);
    assert.equal(context.room.hostId, 2);
    assert.equal(c2.messages.some((message) => message.type === 'lobby.hostChanged'), true);
});

test('resume admission 뒤 연결이 완성되지 않아도 원래 grace가 끝날 때까지 자리를 보존한다', () => {
    const context = setup();
    const c1 = context.connect(context.owner);
    const r2 = seat(2, 0);
    context.room.reserveJoin(r2, 'secret');
    context.connect(r2);
    context.room.disconnect(c1, 'network');

    const shortResume = { ...seat(1, 0, true), expiresAt: 1_000 };
    assert.notEqual(context.room.admitReservation(shortResume), null);
    context.setNow(1_001);
    context.room.advance();
    assert.notEqual(context.room.memberByUser(1), null, 'resume 소켓 실패가 기존 10초 grace를 잘라먹으면 안 된다');

    const retry = seat(1, 1_001, true);
    assert.equal(context.room.canReserveResume(1), null);
    assert.notEqual(context.room.admitReservation(retry), null);
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

    assert.equal(context.room.requestStart(1), ErrorCode.Internal);
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

test('경기 중에 재접속하면 game.starting과 game.started를 다시 받는다', async () => {
    // 두 메시지는 시작하는 순간 한 번만 나갔다. 그래서 경기 도중에 끊겼다 돌아온 사람은
    // 방이 멀쩡히 PLAYING인데도 "경기 시작 신호를 기다리는" 화면에서 영영 멈춰 있었다.
    const { context, c2 } = await playingRoom();

    context.room.disconnect(c2, 'network');
    assert.equal(context.room.canReserveResume(2), null);
    const resumed = seat(2, context.getNow(), true);
    const back = context.connect(resumed);
    await Promise.resolve();

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
