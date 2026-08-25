import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    EffectType, MapMarkerKind, MapZoneKind, SkillId, TilePhysics, TrainingPadKind,
    type MapMarker, type MapZone,
} from 'shared';
import { applyEffect, msToTicks } from '../simulation/effects';
import { stepWorld } from '../simulation/step';
import { mapFromRows, makePlayer, makeWorld, worldFingerprint } from '../simulation/testing';
import type { ResolvedInput, World } from '../simulation/world';
import { TRAINING_DUMMY_RESPAWN_MS, TrainingGround } from './training-ground';

const OPEN_MAP = Array.from({ length: 20 }, (_, y) =>
    y === 0 || y === 19 ? '#'.repeat(20) : `#${'.'.repeat(18)}#`,
);

/**
 * 표적 자리와 패드는 **맵이 정한다.** 테스트도 실제와 같은 경로를 타야 해서 마커를 붙인 맵을 만든다.
 * 순서는 정지 / 순찰 / 추격이고, `ground.players`도 같은 순서다.
 */
const TRAINING_MARKERS: MapMarker[] = [
    { kind: MapMarkerKind.TrainingDummyStill, x: 3, y: 3 },
    { kind: MapMarkerKind.TrainingDummyPatrol, x: 12, y: 3 },
    { kind: MapMarkerKind.TrainingDummyChase, x: 5, y: 14 },
    { kind: MapMarkerKind.SkillDash, x: 6, y: 9 },
    { kind: MapMarkerKind.SkillFlash, x: 8, y: 9 },
    { kind: MapMarkerKind.SkillExhaust, x: 10, y: 9 },
    { kind: MapMarkerKind.Reset, x: 12, y: 9 },
    { kind: MapMarkerKind.Tagger, x: 14, y: 9 },
    { kind: MapMarkerKind.TrainingChaseMode, x: 16, y: 9 },
];

const TRAINING_ZONES: MapZone[] = [
    { kind: MapZoneKind.TrainingCourse, x: 9, y: 1, width: 9, height: 7 },
    { kind: MapZoneKind.TrainingChase, x: 1, y: 11, width: 17, height: 7 },
];

function setup(rows: readonly string[] = OPEN_MAP, withHuman = false): { ground: TrainingGround; world: World } {
    const map = mapFromRows(rows, { markers: TRAINING_MARKERS, zones: TRAINING_ZONES });
    const humans = withHuman ? [makePlayer(1, 2, 10)] : [];
    const ground = new TrainingGround(map, humans.map((player) => player.playerId));
    return { ground, world: makeWorld(map, [...humans, ...ground.players]) };
}

const neutral = (playerId: number): ResolvedInput =>
    ({ playerId, moveX: 0, moveY: 0, heldActions: 0, lastProcessedSequence: 0 });

function stepTraining(world: World, ground: TrainingGround, humanInputs: readonly ResolvedInput[] = []): void {
    const frame = stepWorld(world, [...humanInputs, ...ground.resolveInputs(world)]);
    ground.afterStep(frame.world);
}

test('탈진에 걸린 더미는 같은 tick 동안 코스를 덜 간다', () => {
    const normal = setup();
    const slowed = setup();
    const normalDummy = normal.ground.players[1]!;
    const slowedDummy = slowed.ground.players[1]!;
    const start = { x: normalDummy.x, y: normalDummy.y };

    applyEffect(slowed.world, slowedDummy, EffectType.Exhaust, 0.4, 5_000);
    // 코스가 사각형이라 x만 보면 모서리를 돈 뒤에 줄어든다. 실제로 간 거리로 잰다.
    let normalDistance = 0;
    let slowedDistance = 0;
    let normalAt = { ...start };
    let slowedAt = { x: slowedDummy.x, y: slowedDummy.y };
    for (let tick = 0; tick < 90; tick += 1) {
        stepTraining(normal.world, normal.ground);
        stepTraining(slowed.world, slowed.ground);
        normalDistance += Math.hypot(normalDummy.x - normalAt.x, normalDummy.y - normalAt.y);
        slowedDistance += Math.hypot(slowedDummy.x - slowedAt.x, slowedDummy.y - slowedAt.y);
        normalAt = { x: normalDummy.x, y: normalDummy.y };
        slowedAt = { x: slowedDummy.x, y: slowedDummy.y };
    }

    assert.ok(normalDistance > 0, '정상 표적이 아예 안 움직였다');
    assert.ok(slowedDistance < normalDistance * 0.7, `${slowedDistance} < ${normalDistance} * 0.7`);
});

test('잡힌 더미는 3초 뒤 코스 시작점에서 다시 나온다', () => {
    const { ground, world } = setup();
    const dummy = ground.players[1]!;
    const start = { x: dummy.x, y: dummy.y };
    dummy.alive = false;
    ground.afterStep(world);

    const delayTicks = msToTicks(TRAINING_DUMMY_RESPAWN_MS, world.simulationHz);
    for (let tick = 0; tick < delayTicks; tick += 1) stepTraining(world, ground);
    assert.equal(dummy.alive, false, '부활 시각 전까지는 스냅샷에서 빠진다');

    ground.resolveInputs(world);
    assert.equal(dummy.alive, true);
    assert.deepEqual({ x: dummy.x, y: dummy.y }, start);
});

test('움직이는 코스는 벽을 우회하며 오래 진행한다', () => {
    const rows = Array.from({ length: 20 }, (_, y) => {
        if (y === 0 || y === 19) return '#'.repeat(20);
        const row = Array.from({ length: 20 }, (_, x) => x === 0 || x === 19 ? '#' : '.');
        if (y >= 2 && y <= 17 && y !== 5 && y !== 13) row[10] = '#';
        return row.join('');
    });
    const { ground, world } = setup(rows);
    // 추격 표적은 사람이 구역에 없으면 가만히 있는다(별도 테스트). 여기서는 순찰 표적만 본다.
    const patrol = ground.players[1]!;
    const visited = new Set<string>();

    for (let tick = 0; tick < 2_400; tick += 1) {
        // 이 테스트는 경로 추종만 보므로 20초 술래 강제 교체가 표적을 제거하지 않게 한다.
        world.taggerChangedAtTick = world.tick;
        stepTraining(world, ground);
        for (const player of ground.players) {
            const tx = Math.floor(player.x / world.map.tileSize);
            const ty = Math.floor(player.y / world.map.tileSize);
            assert.notEqual(world.map.tiles[ty]?.[tx], TilePhysics.Wall, `tick ${tick} 표적 ${player.playerId}`);
        }
        visited.add(`${Math.floor(patrol.x / world.map.tileSize)},${Math.floor(patrol.y / world.map.tileSize)}`);
    }

    assert.ok(visited.size >= 12, `순찰 표적이 방문한 타일: ${visited.size}`);
});

test('같은 사람 입력 열과 코스를 두 번 돌리면 같은 결과가 난다', () => {
    const first = setup(OPEN_MAP, true);
    const second = setup(OPEN_MAP, true);

    for (let tick = 0; tick < 600; tick += 1) {
        const moveX = tick % 160 < 80 ? 1 : -1;
        const humanInput: ResolvedInput = {
            playerId: 1, moveX, moveY: 0, heldActions: 0, lastProcessedSequence: tick,
        };
        stepTraining(first.world, first.ground, [humanInput]);
        stepTraining(second.world, second.ground, [humanInput]);
        assert.equal(worldFingerprint(first.world), worldFingerprint(second.world), `tick ${tick}`);
    }
});

test('패드는 밟는 순간에만 발동한다', () => {
    // 서 있는 동안 매 tick 발동하면 스킬이 계속 바뀌어서 고를 수가 없다.
    const { world, ground } = setup(OPEN_MAP, true);
    const human = world.players.find((p) => !ground.isDummy(p.playerId))!;
    const pad = ground.pads.find((p) => p.kind === TrainingPadKind.SkillFlash)!;
    human.loadout = SkillId.Dash;

    human.x = pad.x;
    human.y = pad.y;
    ground.afterStep(world);
    assert.equal(human.loadout, SkillId.Flash, '밟았는데 안 바뀌었다');

    // 밟은 채로 로드아웃을 바꿔 보고, 계속 서 있어도 되돌려지지 않는지 본다.
    human.loadout = SkillId.Exhaust;
    ground.afterStep(world);
    assert.equal(human.loadout, SkillId.Exhaust, '서 있는 동안 다시 발동했다');
});

test('술래 패드는 술래를 씌우고 다시 밟으면 벗긴다', () => {
    const { world, ground } = setup(OPEN_MAP, true);
    const human = world.players.find((p) => !ground.isDummy(p.playerId))!;
    const pad = ground.pads.find((p) => p.kind === TrainingPadKind.Tagger)!;
    const step = (x: number, y: number) => { human.x = x; human.y = y; ground.afterStep(world); };

    step(pad.x, pad.y);
    assert.equal(human.isTagger, true, '술래가 안 됐다');

    step(0, 0);          // 패드에서 내려온다
    step(pad.x, pad.y);  // 다시 밟는다
    assert.equal(human.isTagger, false, '두 번째로 밟았는데 안 벗겨졌다');
});

test('표적은 패드를 밟아도 아무 일이 없다', () => {
    // 표적이 스킬 패드를 밟으면 표적의 성격이 제멋대로 바뀐다.
    const { world, ground } = setup(OPEN_MAP, true);
    const pad = ground.pads.find((p) => p.kind === TrainingPadKind.SkillExhaust)!;
    const dummy = ground.players[0]!;
    const before = dummy.loadout;
    dummy.x = pad.x;
    dummy.y = pad.y;
    ground.afterStep(world);
    assert.equal(dummy.loadout, before);
});

test('훈련장에서는 죽어도 다시 시작할 수 있다', () => {
    const { world, ground } = setup(OPEN_MAP, true);
    const human = world.players.find((p) => !ground.isDummy(p.playerId))!;
    human.alive = false;
    human.stats.eliminatedAtTick = world.tick;

    assert.equal(ground.respawn(world, human.playerId), true);
    assert.equal(human.alive, true);
    assert.equal(human.stats.eliminatedAtTick, null);
    assert.equal(ground.respawn(world, human.playerId), false, '살아 있는데 또 살아났다');
    assert.equal(ground.respawn(world, ground.players[0]!.playerId), false, '표적이 부활 요청으로 살아났다');
});

function zonedTraining() {
    const { world, ground } = setup(OPEN_MAP, true);
    const human = world.players.find((p) => !ground.isDummy(p.playerId))!;
    return { world, ground, human };
}

const chaseDummy = (ground: TrainingGround) => ground.players[2]!;

test('표적 자리와 성격은 맵 마커가 정한다', () => {
    const { ground } = zonedTraining();
    assert.equal(ground.players.length, 3, '마커 셋에 표적 셋');
    assert.deepEqual(ground.roster.map((entry) => entry.nickname), ['[표적] 정지', '[표적] 순찰', '[표적] 추격']);
});

test('추격 표적은 사람이 구역에 들어오기 전까지 가만히 있는다', () => {
    const { world, ground, human } = zonedTraining();
    const dummy = chaseDummy(ground);
    const before = { x: dummy.x, y: dummy.y };

    // 사람은 구역 밖(y=9)에 있다.
    for (let i = 0; i < 60; i++) stepTraining(world, ground, [neutral(human.playerId)]);
    assert.deepEqual({ x: dummy.x, y: dummy.y }, before, '아무도 없는데 움직였다');

    // 구역 안으로 들어간다.
    human.y = 14 * world.map.tileSize + world.map.tileSize / 2;
    human.x = 12 * world.map.tileSize;
    for (let i = 0; i < 60; i++) stepTraining(world, ground, [neutral(human.playerId)]);
    assert.notDeepEqual({ x: dummy.x, y: dummy.y }, before, '사람이 들어왔는데 안 움직인다');
});

test('구역을 나가면 추격 표적이 제자리로 돌아가고 술래가 풀린다', () => {
    const { world, ground, human } = zonedTraining();
    const dummy = chaseDummy(ground);
    const home = { x: dummy.x, y: dummy.y };

    human.y = 14 * world.map.tileSize + world.map.tileSize / 2;
    human.x = 12 * world.map.tileSize;
    for (let i = 0; i < 30; i++) stepTraining(world, ground, [neutral(human.playerId)]);
    assert.equal(human.isTagger, true, '기본 모드에서는 내가 술래다');

    human.y = 9 * world.map.tileSize;  // 구역 밖
    stepTraining(world, ground, [neutral(human.playerId)]);
    assert.deepEqual({ x: dummy.x, y: dummy.y }, home, '표적이 집으로 안 돌아갔다');
    assert.equal(dummy.isTagger, false);
});

test('모드 패드를 밟으면 역할이 뒤집혀 표적이 술래가 된다', () => {
    const { world, ground, human } = zonedTraining();
    const pad = ground.pads.find((p) => p.kind === TrainingPadKind.ChaseMode)!;
    human.x = pad.x;
    human.y = pad.y;
    ground.afterStep(world);
    assert.equal(ground.chaseMode, 'flee');

    human.y = 14 * world.map.tileSize + world.map.tileSize / 2;
    human.x = 12 * world.map.tileSize;
    for (let i = 0; i < 30; i++) stepTraining(world, ground, [neutral(human.playerId)]);
    assert.equal(chaseDummy(ground).isTagger, true, '표적이 술래가 안 됐다');
    assert.equal(human.isTagger, false);
});

test('술래가 된 표적은 사람 쪽으로 다가온다', () => {
    const { world, ground, human } = zonedTraining();
    const pad = ground.pads.find((p) => p.kind === TrainingPadKind.ChaseMode)!;
    human.x = pad.x; human.y = pad.y;
    ground.afterStep(world);

    human.y = 14 * world.map.tileSize + world.map.tileSize / 2;
    human.x = 15 * world.map.tileSize;
    const dummy = chaseDummy(ground);
    stepTraining(world, ground, [neutral(human.playerId)]);
    const before = Math.hypot(dummy.x - human.x, dummy.y - human.y);
    for (let i = 0; i < 60; i++) stepTraining(world, ground, [neutral(human.playerId)]);
    const after = Math.hypot(dummy.x - human.x, dummy.y - human.y);
    assert.ok(after < before, `가까워지지 않았다: ${before} -> ${after}`);
});
