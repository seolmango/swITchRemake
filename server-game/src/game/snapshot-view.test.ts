import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeSnapshot, PROTOCOL_VERSION, SkillId, SkillSlot } from 'shared';
import { stepWorld } from '../simulation/step';
import { mapFromRows, makePlayer, makeWorld } from '../simulation/testing';
import { buildSnapshot, encodeForViewer } from './snapshot-view';
import type { AuthoritativeFrame } from '../simulation/world';

const ROSTER = [
    { playerId: 1, nickname: '술래' },
    { playerId: 2, nickname: '도망자' },
    { playerId: 3, nickname: '숨은사람' },
];

/** 3번은 수풀 한가운데, 1번과 2번은 트인 곳. 1번과 3번은 멀리 떨어져 있다. */
function frame(): AuthoritativeFrame {
    const world = makeWorld(mapFromRows([
        '###########',
        '#.........#',
        '#.........#',
        '#.......bb#',
        '#.......bb#',
        '###########',
    ]), [
        makePlayer(1, 1, 1, { isTagger: true }),
        makePlayer(2, 2, 1),
        makePlayer(3, 9, 4),
    ]);
    return stepWorld(world, []);
}

test('검열된 뷰는 숨은 플레이어를 아예 담지 않는다', () => {
    const snapshot = buildSnapshot(frame(), { playerId: 1, access: 'filtered', full: true }, ROSTER);
    const ids = (snapshot.players ?? []).map((p) => p.id);

    assert.ok(ids.includes(1), '자기 자신이 빠졌다');
    assert.ok(ids.includes(2));
    assert.ok(!ids.includes(3), '수풀에 숨은 사람의 좌표가 전송됐다');
});

test('관전자 뷰는 전원을 담는다', () => {
    const snapshot = buildSnapshot(frame(), { playerId: null, access: 'unfiltered', full: true }, ROSTER);
    const ids = (snapshot.players ?? []).map((p) => p.id).sort();
    assert.deepEqual(ids, [1, 2, 3]);
});

test('관전자에게는 SELF 섹션을 보내지 않는다', () => {
    const spectator = buildSnapshot(frame(), { playerId: null, access: 'unfiltered', full: true }, ROSTER);
    assert.equal(spectator.selfId, undefined);

    const player = buildSnapshot(frame(), { playerId: 2, access: 'filtered', full: true }, ROSTER);
    assert.equal(player.selfId, 2);
});

test('full 스냅샷에만 MAP과 ROSTER가 실린다', () => {
    const f = frame();
    const full = buildSnapshot(f, { playerId: 1, access: 'filtered', full: true }, ROSTER);
    assert.ok(full.map !== undefined, 'MAP이 빠졌다');
    assert.equal(full.roster?.length, 3);

    const delta = buildSnapshot(f, { playerId: 1, access: 'filtered', full: false }, ROSTER);
    assert.equal(delta.map, undefined);
    assert.equal(delta.roster, undefined);
});

test('권위 프레임은 뷰어 수와 무관하게 같다', () => {
    // 관전자가 붙거나 떨어져도 플레이어가 받는 내용이 달라지면 안 된다.
    const f = frame();
    const a = buildSnapshot(f, { playerId: 1, access: 'filtered', full: false }, ROSTER);
    buildSnapshot(f, { playerId: null, access: 'unfiltered', full: true }, ROSTER);
    const b = buildSnapshot(f, { playerId: 1, access: 'filtered', full: false }, ROSTER);
    assert.deepEqual(a, b);
});

test('인코딩한 스냅샷을 클라이언트 디코더가 그대로 읽는다', () => {
    const buffer = encodeForViewer(frame(), { playerId: 1, access: 'filtered', full: true }, ROSTER);
    const decoded = decodeSnapshot(buffer);

    assert.equal(decoded.version, PROTOCOL_VERSION);
    assert.equal(decoded.full, true);
    assert.equal(decoded.selfId, 1);
    assert.equal(decoded.map?.rows, 6);
    assert.deepEqual(decoded.roster?.map((r) => r.nickname), ['술래', '도망자', '숨은사람']);
    assert.ok((decoded.players ?? []).some((p) => p.id === 1 && p.isTagger));
    assert.ok(!(decoded.players ?? []).some((p) => p.id === 3));
});

test('탈락한 플레이어는 어떤 뷰에도 담기지 않는다', () => {
    const f = frame();
    f.world.players[1]!.alive = false;

    const filtered = buildSnapshot(f, { playerId: 1, access: 'filtered', full: false }, ROSTER);
    const unfiltered = buildSnapshot(f, { playerId: null, access: 'unfiltered', full: false }, ROSTER);

    assert.ok(!(filtered.players ?? []).some((p) => p.id === 2));
    assert.ok(!(unfiltered.players ?? []).some((p) => p.id === 2));
});

test('가까이 붙으면 숨은 사람이 obscured로 보인다', () => {
    const world = makeWorld(mapFromRows([
        '######',
        '#..bb#',
        '#..bb#',
        '######',
    ]), [
        makePlayer(1, 2, 1),
        makePlayer(2, 3, 1),
    ]);
    const f = stepWorld(world, []);
    const snapshot = buildSnapshot(f, { playerId: 1, access: 'filtered', full: false }, ROSTER);

    const hidden = (snapshot.players ?? []).find((p) => p.id === 2);
    assert.ok(hidden !== undefined, '바로 옆인데 안 보인다');
    assert.equal(hidden.obscured, true, 'obscured 표시가 빠졌다');
});

test('a filtered snapshot carries only the viewer cooldowns, including ready slots', () => {
    const world = makeWorld(mapFromRows([
        '######',
        '#....#',
        '#....#',
        '######',
    ]), [
        makePlayer(1, 1, 1, {
            loadout: SkillId.Flash,
            cooldowns: { [SkillId.Switch]: 4, [SkillId.Flash]: 100_000 },
        }),
        makePlayer(2, 2, 1, { cooldowns: { [SkillId.Dash]: 20 } }),
    ]);
    const f = stepWorld(world, []);
    const filtered = buildSnapshot(f, { playerId: 1, access: 'filtered', full: false }, ROSTER);
    const unfiltered = buildSnapshot(f, { playerId: null, access: 'unfiltered', full: false }, ROSTER);

    assert.deepEqual(filtered.cooldowns, [
        {
            slot: SkillSlot.Switch,
            remainingMs: Math.round(((world.players[0]!.cooldowns[SkillId.Switch] ?? 0) / world.simulationHz) * 1000),
        },
        { slot: SkillSlot.Movement, remainingMs: 65_535 },
    ]);
    assert.equal(unfiltered.cooldowns, undefined);
});

test('a tagger omits the empty switch slot but includes a ready movement slot', () => {
    const world = makeWorld(mapFromRows([
        '######',
        '#....#',
        '#....#',
        '######',
    ]), [
        makePlayer(1, 1, 1, { isTagger: true, loadout: SkillId.Dash }),
        makePlayer(2, 2, 1),
    ]);
    const snapshot = buildSnapshot(stepWorld(world, []), { playerId: 1, access: 'filtered', full: false }, ROSTER);

    assert.deepEqual(snapshot.cooldowns, [{ slot: SkillSlot.Movement, remainingMs: 0 }]);
});

test('emoji state is visible in snapshots only until its expiry tick', () => {
    const world = makeWorld(mapFromRows([
        '######',
        '#....#',
        '#....#',
        '######',
    ]), [
        makePlayer(1, 1, 1, { emoji: { emojiId: 7, expiresAtTick: 2 } }),
        makePlayer(2, 2, 1),
    ]);

    const visible = buildSnapshot(stepWorld(world, []), { playerId: null, access: 'unfiltered', full: false }, ROSTER);
    assert.equal(visible.players?.find((player) => player.id === 1)?.emojiId, 7);

    const expired = buildSnapshot(stepWorld(world, []), { playerId: null, access: 'unfiltered', full: false }, ROSTER);
    assert.equal(expired.players?.find((player) => player.id === 1)?.emojiId, undefined);
    assert.equal(world.players[0]!.emoji, null);
});
