import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GAMEPLAY } from '../config/gameplay';
import { isFinished, stepWorld } from './step';
import { mapFromRows, makePlayer, makeWorld, TEST_TILE_SIZE, worldFingerprint } from './testing';
import type { ResolvedInput } from './world';

function input(playerId: number, moveX: number, moveY: number): ResolvedInput {
    return { playerId, moveX, moveY, heldActions: 0, lastProcessedSequence: 0 };
}

const OPEN_MAP = [
    '#######',
    '#.....#',
    '#.....#',
    '#.....#',
    '#.....#',
    '#.....#',
    '#######',
];

test('같은 초기 상태와 같은 입력은 같은 결과를 만든다', () => {
    const script: ResolvedInput[][] = [];
    for (let i = 0; i < 120; i++) {
        script.push([
            input(1, i % 3 === 0 ? 1 : -1, i % 5 === 0 ? 1 : 0),
            input(2, i % 2 === 0 ? -1 : 1, i % 7 === 0 ? -1 : 0),
            input(3, 1, 1),
        ]);
    }

    const run = () => {
        const world = makeWorld(mapFromRows(OPEN_MAP), [
            makePlayer(1, 1, 1, { isTagger: true }),
            makePlayer(2, 3, 3),
            makePlayer(3, 5, 5),
        ]);
        for (const inputs of script) stepWorld(world, inputs);
        return worldFingerprint(world);
    };

    assert.equal(run(), run());
});

test('플레이어 순서를 바꿔도 결과가 같다', () => {
    // pair를 playerId 오름차순으로 정렬하지 않으면 배열 순서가 결과를 바꾼다.
    const build = (order: number[]) => {
        const byId = new Map([
            [1, () => makePlayer(1, 2, 2, { isTagger: true })],
            [2, () => makePlayer(2, 2, 2)],
            [3, () => makePlayer(3, 3, 2)],
        ]);
        const world = makeWorld(mapFromRows(OPEN_MAP), order.map((id) => byId.get(id)!()));
        for (let i = 0; i < 30; i++) {
            stepWorld(world, [input(1, 1, 0), input(2, -1, 0), input(3, 0, 1)]);
        }
        world.players.sort((a, b) => a.playerId - b.playerId);
        return worldFingerprint(world);
    };

    assert.equal(build([1, 2, 3]), build([3, 1, 2]));
});

test('플레이어가 벽을 통과하지 못한다', () => {
    const world = makeWorld(mapFromRows(OPEN_MAP), [makePlayer(1, 1, 1)]);
    for (let i = 0; i < 200; i++) stepWorld(world, [input(1, -1, -1)]);

    const p = world.players[0]!;
    // 벽은 타일 0번 줄과 0번 칸이다. 반지름만큼 떨어진 곳이 한계다.
    assert.ok(p.x >= TEST_TILE_SIZE + p.radius - 0.001, `x가 벽을 파고들었다: ${p.x}`);
    assert.ok(p.y >= TEST_TILE_SIZE + p.radius - 0.001, `y가 벽을 파고들었다: ${p.y}`);
});

test('한 tick 이동량이 커도 얇은 벽을 뚫지 못한다', () => {
    // 대시처럼 순간 이동량이 크면 sub-step 없이는 벽을 그냥 넘어간다.
    const world = makeWorld(mapFromRows([
        '#####',
        '#.#.#',
        '#####',
    ]), [makePlayer(1, 1, 1)]);

    const p = world.players[0]!;
    const wallLeftEdge = 2 * TEST_TILE_SIZE;
    // 벽 너머로 한 번에 보내려는 후보 위치를 만든다.
    p.vx = 100_000;
    stepWorld(world, [input(1, 1, 0)]);

    assert.ok(p.x <= wallLeftEdge - p.radius + 0.001, `벽을 통과했다: x=${p.x}`);
});

test('플레이어끼리 겹치지 않는다', () => {
    const world = makeWorld(mapFromRows(OPEN_MAP), [
        makePlayer(1, 2, 3),
        makePlayer(2, 4, 3),
    ]);
    for (let i = 0; i < 120; i++) stepWorld(world, [input(1, 1, 0), input(2, -1, 0)]);

    const [a, b] = world.players as [typeof world.players[0], typeof world.players[0]];
    const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    assert.ok(dist >= a!.radius + b!.radius - 0.5, `겹쳤다: 거리 ${dist}`);
});

test('빠르게 접근한 쪽이 덜 밀린다', () => {
    const world = makeWorld(mapFromRows(OPEN_MAP), [
        makePlayer(1, 3, 3),
        makePlayer(2, 3, 3, { x: 3.5 * TEST_TILE_SIZE + GAMEPLAY.PLAYER_RADIUS_PX, y: 3.5 * TEST_TILE_SIZE }),
    ]);
    const startX1 = world.players[0]!.x;
    const startX2 = world.players[1]!.x;

    // 1번은 오른쪽으로 달려들고 2번은 가만히 있는다.
    stepWorld(world, [input(1, 1, 0), input(2, 0, 0)]);

    const moved1 = Math.abs(world.players[0]!.x - startX1);
    const moved2 = Math.abs(world.players[1]!.x - startX2);
    assert.ok(moved2 > 0, '정지한 쪽이 전혀 밀리지 않았다');
    assert.ok(moved2 > moved1, `달려든 쪽이 더 밀렸다: 공격 ${moved1}, 정지 ${moved2}`);
});

test('술래 접촉은 충돌 해결로 떨어진 뒤에도 판정된다', () => {
    // 충돌 해결이 두 원을 정확히 떼어놓으므로, 최종 거리를 재면 항상 "닿지 않음"이 된다.
    // 이번 tick의 collision pair로 판정해야 술래가 잡을 수 있다.
    const world = makeWorld(mapFromRows(OPEN_MAP), [
        makePlayer(1, 3, 3, { isTagger: true }),
        makePlayer(2, 3, 3, { x: 3.5 * TEST_TILE_SIZE + GAMEPLAY.PLAYER_RADIUS_PX * 1.5, y: 3.5 * TEST_TILE_SIZE }),
    ]);

    const frame = stepWorld(world, [input(1, 1, 0), input(2, 0, 0)]);

    const victim = world.players[1]!;
    assert.equal(victim.alive, false, '접촉했는데 탈락하지 않았다');
    assert.ok(frame.events.some((e) => e.kind === 'eliminated' && e.playerId === 2));

    const dist = Math.hypot(world.players[0]!.x - victim.x, world.players[0]!.y - victim.y);
    assert.ok(dist >= GAMEPLAY.PLAYER_RADIUS_PX * 2 - 0.5, '판정 시점에 이미 분리돼 있어야 이 테스트가 의미 있다');
});

test('술래는 자기 자신을 잡지 않는다', () => {
    const world = makeWorld(mapFromRows(OPEN_MAP), [makePlayer(1, 3, 3, { isTagger: true })]);
    stepWorld(world, [input(1, 1, 0)]);
    assert.equal(world.players[0]!.alive, true);
});

test('자기장이 플레이어를 안쪽으로 밀어낸다', () => {
    const world = makeWorld(mapFromRows([
        '.....',
        '.....',
        '.....',
        '.....',
        '.....',
    ], { barrierSpeed: 5 }), [makePlayer(1, 0, 0)]);

    for (let i = 0; i < 60; i++) stepWorld(world, [input(1, -1, -1)]);

    const p = world.players[0]!;
    const storm = world.storm!;
    assert.ok(storm.width > p.radius * 2, '이 테스트는 자기장이 아직 유효할 때를 봐야 한다');
    assert.ok(p.x >= storm.x + p.radius - 0.001, `자기장 밖으로 나갔다: x=${p.x}, storm.x=${storm.x}`);
    assert.ok(p.y >= storm.y + p.radius - 0.001, `자기장 밖으로 나갔다: y=${p.y}, storm.y=${storm.y}`);
});

test('자기장이 플레이어 지름보다 좁아져도 좌표가 튀지 않는다', () => {
    // 경기는 그 전에 끝나야 정상이지만, 안 끝났을 때 좌표가 발산하는 것보다는 중앙 고정이 낫다.
    const world = makeWorld(mapFromRows([
        '.....',
        '.....',
        '.....',
        '.....',
        '.....',
    ], { barrierSpeed: 40 }), [makePlayer(1, 0, 0)]);

    for (let i = 0; i < 60; i++) stepWorld(world, [input(1, -1, -1)]);

    const p = world.players[0]!;
    assert.equal(world.storm!.width, 0, '이 시점에는 자기장이 완전히 닫혀 있어야 한다');
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), '좌표가 발산했다');
    assert.equal(p.x, world.storm!.x + world.storm!.width / 2);
});

test('자기장 inset이 tick에 정확히 비례한다', () => {
    const world = makeWorld(mapFromRows(OPEN_MAP, { barrierSpeed: 7 }), [makePlayer(1, 3, 3)]);
    for (let i = 0; i < 10; i++) stepWorld(world, [input(1, 0, 0)]);
    assert.equal(world.storm!.x, 70, 'inset = tick * barrierSpeed여야 timeline과 어긋나지 않는다');
});

test('맵 timeline이 해당 tick에 적용된다', () => {
    const world = makeWorld(mapFromRows([
        '#####',
        '#.#.#',
        '#####',
    ], { timeline: { 3: [[2, 1, 0]] } }), [makePlayer(1, 1, 1)]);

    stepWorld(world, [input(1, 0, 0)]);
    assert.equal(world.map.tiles[1]![2], 1, 'tick 3 전에는 벽 그대로여야 한다');

    stepWorld(world, [input(1, 0, 0)]);
    const frame = stepWorld(world, [input(1, 0, 0)]);
    assert.equal(world.map.tiles[1]![2], 0, 'tick 3에 벽이 부서져야 한다');
    assert.deepEqual(frame.world.tileChanges, [{ x: 2, y: 1, physics: 0 }]);
});

test('생존자가 정원 이하로 줄면 경기가 끝난다', () => {
    const world = makeWorld(mapFromRows(OPEN_MAP), [
        makePlayer(1, 1, 1, { isTagger: true }),
        makePlayer(2, 3, 3),
        makePlayer(3, 5, 5),
    ]);
    assert.equal(isFinished(world), false);

    world.players[2]!.alive = false;
    assert.equal(isFinished(world), true, '최후 2인이 남으면 종료다');
});

test('연결이 끊긴 플레이어는 마지막 방향으로 계속 가지 않는다', () => {
    const world = makeWorld(mapFromRows(OPEN_MAP), [makePlayer(1, 3, 3)]);
    stepWorld(world, [input(1, 1, 0)]);
    const afterMove = world.players[0]!.x;

    // 입력이 오지 않는다 = 연결이 끊겼다.
    for (let i = 0; i < 30; i++) stepWorld(world, []);

    assert.equal(world.players[0]!.x, afterMove, '입력이 없는데 계속 움직였다');
    assert.equal(world.players[0]!.vx, 0);
});

test('탈락한 플레이어는 더 이상 움직이지 않는다', () => {
    const world = makeWorld(mapFromRows(OPEN_MAP), [makePlayer(1, 3, 3, { alive: false })]);
    const startX = world.players[0]!.x;
    for (let i = 0; i < 10; i++) stepWorld(world, [input(1, 1, 0)]);
    assert.equal(world.players[0]!.x, startX);
});
