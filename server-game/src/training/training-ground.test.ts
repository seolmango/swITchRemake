import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EffectType, SkillId, TilePhysics, TrainingPadKind } from 'shared';
import { applyEffect, msToTicks } from '../simulation/effects';
import { stepWorld } from '../simulation/step';
import { mapFromRows, makePlayer, makeWorld, worldFingerprint } from '../simulation/testing';
import type { ResolvedInput, World } from '../simulation/world';
import { TRAINING_DUMMY_RESPAWN_MS, TrainingGround } from './training-ground';

const OPEN_MAP = Array.from({ length: 20 }, (_, y) =>
    y === 0 || y === 19 ? '#'.repeat(20) : `#${'.'.repeat(18)}#`,
);

function setup(rows: readonly string[] = OPEN_MAP, withHuman = false): { ground: TrainingGround; world: World } {
    const map = mapFromRows(rows);
    const humans = withHuman ? [makePlayer(1, 2, 10)] : [];
    const ground = new TrainingGround(map, humans.map((player) => player.playerId));
    return { ground, world: makeWorld(map, [...humans, ...ground.players]) };
}

function stepTraining(world: World, ground: TrainingGround, humanInputs: readonly ResolvedInput[] = []): void {
    const frame = stepWorld(world, [...humanInputs, ...ground.resolveInputs(world)]);
    ground.afterStep(frame.world);
}

test('탈진에 걸린 더미는 같은 tick 동안 코스를 덜 간다', () => {
    const normal = setup();
    const slowed = setup();
    const normalDummy = normal.ground.players[1]!;
    const slowedDummy = slowed.ground.players[1]!;
    const startX = normalDummy.x;

    applyEffect(slowed.world, slowedDummy, EffectType.Exhaust, 0.4, 5_000);
    for (let tick = 0; tick < 90; tick += 1) {
        stepTraining(normal.world, normal.ground);
        stepTraining(slowed.world, slowed.ground);
    }

    const normalDistance = normalDummy.x - startX;
    const slowedDistance = slowedDummy.x - startX;
    assert.ok(normalDistance > 0);
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
    const visited = ground.players.slice(1).map(() => new Set<string>());

    for (let tick = 0; tick < 2_400; tick += 1) {
        // 이 테스트는 경로 추종만 보므로 20초 술래 강제 교체가 표적을 제거하지 않게 한다.
        world.taggerChangedAtTick = world.tick;
        stepTraining(world, ground);
        ground.players.slice(1).forEach((player, index) => {
            const tx = Math.floor(player.x / world.map.tileSize);
            const ty = Math.floor(player.y / world.map.tileSize);
            assert.notEqual(world.map.tiles[ty]?.[tx], TilePhysics.Wall, `tick ${tick} dummy ${index}`);
            visited[index]!.add(`${tx},${ty}`);
        });
    }

    assert.ok(visited[0]!.size >= 8, `왕복 더미가 방문한 타일: ${visited[0]!.size}`);
    assert.ok(visited[1]!.size >= 20, `순환 더미가 방문한 타일: ${visited[1]!.size}`);
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
