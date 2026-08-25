import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_PLAYERS_PER_ROOM, PlayerRole } from 'shared';
import type { SeatReservation } from '../gateway/ticket-store';
import { LobbyRoster, StartLock } from './lobby-state';

function reservation(userId: number, player = userId): SeatReservation {
    return {
        userId,
        nickname: `player-${player}`,
        lobbyStats: null,
        roomId: 'room-1',
        serverId: 'game-1',
        issuedAt: 0,
        expiresAt: 10_000,
        resume: false,
    };
}

test('roster가 예약까지 정원에 포함하고 자리를 옮기면 번호와 색이 함께 간다', () => {
    const roster = new LobbyRoster(3);
    assert.deepEqual(roster.hold(reservation(10)), { ok: true, playerId: 1 });
    assert.deepEqual(roster.hold(reservation(20)), { ok: true, playerId: 2 });
    assert.deepEqual(roster.hold(reservation(30)), { ok: true, playerId: 3 });
    assert.deepEqual(roster.hold(reservation(40)), { ok: false, reason: 'full' });

    const first = roster.claim(10, 1, PlayerRole.Player)!;
    const second = roster.claim(20, 1, PlayerRole.Player)!;
    assert.equal(roster.hostId, first.playerId);
    assert.equal(roster.moveSlot(10, 2), 'occupied');
    assert.equal(roster.moveSlot(10, 3), 'occupied', '아직 인증 전인 예약 자리도 점유 중이다');

    roster.releaseHold(30);
    assert.equal(roster.moveSlot(10, 3), 'moved');
    // 대기실에서 보이는 숫자, 몸에 찍히는 숫자, 남이 스위치하려고 누르는 숫자가 전부 같아야 한다.
    // 예전에는 playerId를 고정하고 slot만 옮겨서, 6번을 고른 사람이 인게임에서 3번으로 나왔다.
    assert.equal(first.slot, 3);
    assert.equal(first.playerId, 3, '자리를 옮기면 인게임 번호도 따라간다');
    assert.equal(first.colorIndex, 2, '색도 번호를 따라간다');

    assert.equal(roster.passHost(10, second.playerId), true);
    assert.equal(roster.hostId, second.playerId);
    const removed = roster.remove(20)!;
    assert.equal(removed.hostChanged, true);
    assert.equal(roster.hostId, first.playerId, '방장 퇴장 시 가장 먼저 들어온 참가자가 이어받는다');
});

test('lobby colorIndex is the zero-based palette index for every one-based playerId', () => {
    const roster = new LobbyRoster(MAX_PLAYERS_PER_ROOM);
    for (let playerId = 1; playerId <= MAX_PLAYERS_PER_ROOM; playerId += 1) {
        assert.deepEqual(roster.hold(reservation(playerId)), { ok: true, playerId });
        assert.equal(roster.claim(playerId, 1, PlayerRole.Player)?.colorIndex, playerId - 1);
    }
    assert.deepEqual(roster.members().map((member) => member.colorIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('참가 잠금은 60초 rolling window에서 15초까지만 grant한다', () => {
    const lock = new StartLock({
        joinLockMs: 5_000,
        joinBudgetMs: 15_000,
        joinBudgetWindowMs: 60_000,
        mapLockMs: 10_000,
    });
    assert.equal(lock.applyJoin(0), 5_000);
    assert.equal(lock.applyJoin(1), 5_000);
    assert.equal(lock.applyJoin(2), 5_000);
    assert.equal(lock.applyJoin(3), 0, '같은 창의 네 번째 참가는 잠금을 늘리지 못한다');
    assert.equal(lock.remainingMs(3), 4_999);

    lock.applyMapChange(4_000);
    assert.equal(lock.remainingMs(4_000), 10_000, '맵 변경 잠금은 참가 budget과 별개다');
    assert.equal(lock.applyJoin(60_000), 5_000, 'rolling window를 벗어난 grant는 budget에서 빠진다');
});
