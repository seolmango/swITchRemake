import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EffectType, TilePhysics } from 'shared';
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
