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
    // 스킬도 같이 태운다. 표적이 점멸을 쓰는 경로가 여기를 지나므로 빼면 실제와 다른 것을 잰다.
    const frame = stepWorld(world, [...humanInputs, ...ground.resolveInputs(world)], ground.resolveSkills(world));
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

/**
 * 추격 구역 한가운데를 세로 벽이 가른다. 표적은 왼쪽(5,14), 사람은 오른쪽에 선다.
 *
 * 벽에 문이 하나 있다(y=17). 길찾기가 돌아갈 길을 찾을 수 있어야 "벽에 걸린다"와 "길이 없다"가
 * 구분된다.
 */
const WALLED_MAP = Array.from({ length: 20 }, (_, y) => {
    if (y === 0 || y === 19) return '#'.repeat(20);
    const row = [...`#${'.'.repeat(18)}#`];
    if (y >= 11 && y <= 16) row[9] = '#';
    return row.join('');
});

function walledChase(mode: 'hunt' | 'flee' = 'flee') {
    const map = mapFromRows(WALLED_MAP, { markers: TRAINING_MARKERS, zones: TRAINING_ZONES });
    const human = makePlayer(1, 13, 14);
    const ground = new TrainingGround(map, [human.playerId]);
    const world = makeWorld(map, [human, ...ground.players]);
    if (mode === 'flee') {
        // 모드 패드를 밟아 표적을 술래로 만든다. 사람을 쫓는 쪽이 표적이어야 추격을 볼 수 있다.
        const pad = ground.pads.find((p) => p.kind === TrainingPadKind.ChaseMode)!;
        human.x = pad.x;
        human.y = pad.y;
        ground.afterStep(world);
        human.x = 13 * map.tileSize + map.tileSize / 2;
        human.y = 14 * map.tileSize + map.tileSize / 2;
    }
    return { world, ground, human, dummy: chaseDummy(ground) };
}

test('추격 표적이 벽을 돌아서 온다', () => {
    // 예전에는 직진뿐이라 벽에 붙어 비볐다. 그러면 추격 구역이 통째로 논다.
    const { world, ground, human, dummy } = walledChase();
    // 점멸로 넘는 것과 구분해서 길찾기만 본다.
    dummy.loadout = SkillId.Dash;
    const wallX = 9 * world.map.tileSize;

    let crossed = false;
    for (let i = 0; i < 900 && !crossed; i++) {
        dummy.cooldowns[SkillId.Dash] = 100_000;
        stepTraining(world, ground, [neutral(human.playerId)]);
        // 잡으면 추격이 끝나고 표적이 집으로 돌아간다. 그 전에 벽을 넘었는지만 본다.
        if (dummy.x > wallX + world.map.tileSize) crossed = true;
    }

    assert.ok(crossed, `벽에 걸렸다. 표적이 x=${Math.round(dummy.x)}에서 못 넘어왔다`);
});

test('길이 뚫려 있으면 표적이 타일 격자가 아니라 사람을 향해 곧장 간다', () => {
    const { world, ground, human, dummy } = walledChase();
    // 둘 다 벽 오른쪽에 두어 사이를 막는 것이 없게 한다.
    dummy.x = 12 * world.map.tileSize + world.map.tileSize / 2;
    dummy.y = 17 * world.map.tileSize + world.map.tileSize / 2;
    human.x = 16 * world.map.tileSize + world.map.tileSize / 2;
    human.y = 12 * world.map.tileSize + world.map.tileSize / 2;

    const input = ground.resolveInputs(world).find((entry) => entry.playerId === dummy.playerId)!;
    const dx = human.x - dummy.x;
    const dy = human.y - dummy.y;
    const length = Math.hypot(dx, dy);
    assert.ok(Math.abs(input.moveX - dx / length) < 1e-9, '가로 성분이 사람 쪽이 아니다');
    assert.ok(Math.abs(input.moveY - dy / length) < 1e-9, '세로 성분이 사람 쪽이 아니다');
});

test('벽 너머의 표적은 한 tick 조준한 뒤 점멸로 넘어온다', () => {
    const { world, ground, human, dummy } = walledChase();
    dummy.loadout = SkillId.Flash;
    // 벽 바로 앞에 세운다. 여기서 사람 쪽으로 점멸하면 벽을 넘는다.
    const place = () => {
        dummy.x = 8 * world.map.tileSize + world.map.tileSize / 2;
        dummy.y = 13 * world.map.tileSize + world.map.tileSize / 2;
        human.x = 11 * world.map.tileSize + world.map.tileSize / 2;
        human.y = 13 * world.map.tileSize + world.map.tileSize / 2;
    };
    place();

    // 실제 호출 순서를 따른다: 입력이 먼저(조준이 여기서 일어난다), 스킬이 나중.
    ground.resolveInputs(world);
    assert.deepEqual(ground.resolveSkills(world), [], '조준한 tick에 바로 쐈다 — facing이 아직 경로 방향이다');

    // 다음 tick. 이제 facing이 사람 쪽이다.
    world.tick += 1;
    place();
    ground.resolveInputs(world);
    const queued = ground.resolveSkills(world);
    assert.equal(queued.length, 1, '조준했는데 안 쏜다');
    assert.equal(queued[0]?.playerId, dummy.playerId);
});

test('점멸을 쏘면 표적이 벽 반대쪽에 선다', () => {
    const { world, ground, human, dummy } = walledChase();
    dummy.loadout = SkillId.Flash;
    const wallX = 9 * world.map.tileSize;

    // 한 번만 세워 두고 흘러가게 둔다. 매 tick 자리를 되돌리면 조준-발사 두 tick이 성립하지 않는다.
    dummy.x = 8 * world.map.tileSize + world.map.tileSize / 2;
    dummy.y = 13 * world.map.tileSize + world.map.tileSize / 2;
    human.x = 11 * world.map.tileSize + world.map.tileSize / 2;
    human.y = 13 * world.map.tileSize + world.map.tileSize / 2;

    let crossed = false;
    for (let i = 0; i < 20 && !crossed; i++) {
        stepTraining(world, ground, [neutral(human.playerId)]);
        if (dummy.x > wallX + world.map.tileSize / 2) crossed = true;
    }

    // 걸어서는 20 tick에 3칸을 갈 수 없다. 넘었다면 점멸이다.
    assert.ok(crossed, '점멸을 쐈는데 벽을 못 넘었다');
});

test('길이 뚫려 있으면 점멸을 쓰지 않는다', () => {
    // 뚫린 길에서 점멸하면 3칸 앞으로 가는 것뿐이고, 사람은 "왜 저기서 썼지"라고 느낀다.
    const { world, ground, human, dummy } = walledChase();
    dummy.loadout = SkillId.Flash;
    dummy.x = 12 * world.map.tileSize + world.map.tileSize / 2;
    dummy.y = 14 * world.map.tileSize + world.map.tileSize / 2;
    human.x = 16 * world.map.tileSize + world.map.tileSize / 2;
    human.y = 14 * world.map.tileSize + world.map.tileSize / 2;

    ground.resolveInputs(world);
    assert.deepEqual(ground.resolveSkills(world), []);
});

test('쿨타임 중에는 스킬을 요청하지 않는다', () => {
    const { world, ground, human, dummy } = walledChase();
    dummy.loadout = SkillId.Flash;
    dummy.cooldowns[SkillId.Flash] = 500;
    dummy.x = 8 * world.map.tileSize + world.map.tileSize / 2;
    dummy.y = 13 * world.map.tileSize + world.map.tileSize / 2;
    human.x = 11 * world.map.tileSize + world.map.tileSize / 2;
    human.y = 13 * world.map.tileSize + world.map.tileSize / 2;

    ground.resolveInputs(world);
    assert.deepEqual(ground.resolveSkills(world), []);
});

test('사람이 구역 밖이면 표적은 스킬도 쓰지 않는다', () => {
    const { world, ground, human, dummy } = walledChase();
    dummy.loadout = SkillId.Flash;
    human.y = 9 * world.map.tileSize;   // 추격 구역 밖
    ground.resolveInputs(world);
    assert.deepEqual(ground.resolveSkills(world), []);
});
