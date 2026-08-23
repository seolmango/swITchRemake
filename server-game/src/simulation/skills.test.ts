import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EffectType } from 'shared';
import { GAMEPLAY, SKILLS, SPEED } from '../config/gameplay';
import { applyEffect, currentSpeed, msToTicks } from './effects';
import { SkillId, useSkill } from './skills';
import { isPositionFree } from './static-collision';
import { stepWorld } from './step';
import { stormRect } from './storm';
import { mapFromRows, makePlayer, makeWorld, TEST_TILE_SIZE } from './testing';
import type { SkillRequest } from './skills';
import type { World, WorldEvent } from './world';

const OPEN = [
    '#########',
    '#.......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#########',
];

const BASE = GAMEPLAY.BASE_MOVE_SPEED_PX_PER_SEC;

function use(world: World, request: SkillRequest) {
    const events: WorldEvent[] = [];
    const outcome = useSkill(world, request, events);
    return { outcome, events };
}

/* ────────────────────────── 속도 계산식 ────────────────────────── */

test('레거시 기준 속도가 유지된다', () => {
    // 레거시: 58 milli-tile/tick @ 30Hz × 256px = 445.44 px/s
    assert.ok(Math.abs(BASE - 445.44) < 0.01, `기준 속도가 레거시와 다르다: ${BASE}`);
});

test('유체화는 레거시 boost와 같은 3배다', () => {
    const world = makeWorld(mapFromRows(OPEN), [makePlayer(1, 2, 2)]);
    const p = world.players[0]!;
    applyEffect(world, p, EffectType.Dash, SKILLS.DASH.SPEED_INCREASE, SKILLS.DASH.DURATION_MS);
    assert.ok(Math.abs(currentSpeed(p) - BASE * 3) < 0.01, `${currentSpeed(p)} != ${BASE * 3}`);
});

test('증가군과 감소군은 더해진 뒤 곱해진다', () => {
    // 하나의 덧셈 풀이면 탈진이 유체화를 상쇄해 "해제"처럼 보인다. 군을 곱하면 둘 다 남는다.
    const world = makeWorld(mapFromRows(OPEN), [makePlayer(1, 2, 2)]);
    const p = world.players[0]!;
    applyEffect(world, p, EffectType.Dash, 0.5, 1000);
    applyEffect(world, p, EffectType.Exhaust, 0.5, 1000);
    assert.ok(Math.abs(currentSpeed(p) - BASE * 1.5 * 0.5) < 0.01, '(1+0.5)×(1-0.5) 이어야 한다');
});

test('같은 타입은 중첩되지 않고 더 강한 쪽으로 갱신된다', () => {
    // 탈진 두 번에 속도가 0이 되면 안 되고, 약한 효과가 강한 효과를 덮어써도 안 된다.
    const world = makeWorld(mapFromRows(OPEN), [makePlayer(1, 2, 2)]);
    const p = world.players[0]!;
    applyEffect(world, p, EffectType.Exhaust, 0.4, 3000);
    applyEffect(world, p, EffectType.Exhaust, 0.1, 5000);

    assert.equal(p.effects[EffectType.Exhaust]!.magnitude, 0.4, '약한 감속이 강한 감속을 지웠다');
    assert.equal(p.effects[EffectType.Exhaust]!.endTick, msToTicks(5000, world.simulationHz), '지속시간은 긴 쪽이다');
});

test('감속이 아무리 겹쳐도 속도가 바닥 아래로 내려가지 않는다', () => {
    const world = makeWorld(mapFromRows(OPEN), [makePlayer(1, 2, 2)]);
    const p = world.players[0]!;
    applyEffect(world, p, EffectType.Exhaust, 5.0, 1000);
    assert.ok(Math.abs(currentSpeed(p) - BASE * SPEED.DECREASE_FLOOR) < 0.01);
    assert.ok(currentSpeed(p) > 0, '속도가 0이나 음수가 되면 안 된다');
});

test('효과가 만료되면 속도가 돌아온다', () => {
    const world = makeWorld(mapFromRows(OPEN), [makePlayer(1, 2, 2)]);
    const p = world.players[0]!;
    applyEffect(world, p, EffectType.Dash, SKILLS.DASH.SPEED_INCREASE, SKILLS.DASH.DURATION_MS);

    const ticks = msToTicks(SKILLS.DASH.DURATION_MS, world.simulationHz);
    for (let i = 0; i < ticks + 1; i++) stepWorld(world, []);

    assert.equal(p.effects[EffectType.Dash], undefined);
    assert.ok(Math.abs(currentSpeed(p) - BASE) < 0.01);
});

/* ────────────────────────── 쿨타임 ────────────────────────── */

test('쿨타임 중에는 다시 쓸 수 없다', () => {
    const world = makeWorld(mapFromRows(OPEN), [makePlayer(1, 2, 2, { loadout: SkillId.Dash })]);
    assert.equal(use(world, { playerId: 1, slot: 2 }).outcome.ok, true);
    assert.deepEqual(use(world, { playerId: 1, slot: 2 }).outcome, { ok: false, reason: 'ON_COOLDOWN' });
});

test('술래는 쿨타임이 두 배로 빨리 찬다', () => {
    // 레거시가 매 tick 2씩 깎았다. 쫓는 쪽이 더 자주 써야 추격이 성립한다.
    const runnerWorld = makeWorld(mapFromRows(OPEN), [makePlayer(1, 2, 2, { loadout: SkillId.Dash })]);
    const taggerWorld = makeWorld(mapFromRows(OPEN), [makePlayer(1, 2, 2, { loadout: SkillId.Dash, isTagger: true })]);

    use(runnerWorld, { playerId: 1, slot: 2 });
    use(taggerWorld, { playerId: 1, slot: 2 });

    const half = Math.ceil(msToTicks(SKILLS.DASH.COOLDOWN_MS, runnerWorld.simulationHz) / 2) + 1;
    for (let i = 0; i < half; i++) {
        stepWorld(runnerWorld, []);
        stepWorld(taggerWorld, []);
    }

    assert.equal(taggerWorld.players[0]!.cooldowns[SkillId.Dash], undefined, '술래 쿨타임이 안 찼다');
    assert.ok((runnerWorld.players[0]!.cooldowns[SkillId.Dash] ?? 0) > 0, '러너가 술래만큼 빨리 찼다');
});

/* ────────────────────────── 점멸 ────────────────────────── */

test('점멸은 바라보는 방향으로 순간이동한다', () => {
    const world = makeWorld(mapFromRows(OPEN), [
        makePlayer(1, 2, 3, { loadout: SkillId.Flash, facingX: 1, facingY: 0 }),
    ]);
    const startX = world.players[0]!.x;
    const { outcome, events } = use(world, { playerId: 1, slot: 2 });

    assert.equal(outcome.ok, true);
    assert.ok(world.players[0]!.x > startX + TEST_TILE_SIZE, '거의 움직이지 않았다');
    assert.ok(events.some((e) => e.kind === 'blinked'), '점멸 이벤트가 없다');
});

test('점멸은 벽을 넘는다', () => {
    // 벽을 못 넘으면 유체화와 밸런스가 맞지 않는다. 유체화는 1초 동안 더 먼 거리를 벌 수 있으므로
    // 점멸의 값어치는 거리가 아니라 벽 너머로 간다는 데 있다.
    const world = makeWorld(mapFromRows([
        '#######',
        '#.#...#',
        '#######',
    ]), [makePlayer(1, 1, 1, { loadout: SkillId.Flash, facingX: 1, facingY: 0 })]);

    use(world, { playerId: 1, slot: 2 });

    const p = world.players[0]!;
    assert.ok(p.x > 2 * TEST_TILE_SIZE + p.radius, `벽을 못 넘었다: x=${p.x}`);
});

test('착지점이 벽 속이면 진행 방향으로 밀려난다', () => {
    // 뒤로 되돌리면 "썼는데 제자리"라 불쾌하다. 애매한 상황은 쓴 사람에게 유리하게 푼다.
    // 타일 1에서 출발하면 3타일 앞(x=1152)이 타일 4 한가운데다. 거기를 벽으로 뒀다.
    const world = makeWorld(mapFromRows([
        '########',
        '#...#..#',
        '########',
    ]), [makePlayer(1, 1, 1, { loadout: SkillId.Flash, facingX: 1, facingY: 0 })]);

    const startX = world.players[0]!.x;
    const targetX = startX + SKILLS.FLASH.DISTANCE_PX;
    // 목표 지점이 실제로 벽 속인지 먼저 확인해야 이 테스트가 의미 있다.
    assert.ok(
        !isPositionFree(world.map, targetX, world.players[0]!.y, world.players[0]!.radius, stormRect(world)),
        '목표 지점이 벽 속이 아니면 밀어낼 일이 없다',
    );

    use(world, { playerId: 1, slot: 2 });

    const p = world.players[0]!;
    assert.ok(p.x >= targetX, `뒤로 밀렸다: 목표 ${targetX}, 실제 ${p.x}`);
    assert.ok(isPositionFree(world.map, p.x, p.y, p.radius, stormRect(world)), '벽 속에 남았다');
});

test('앞이 완전히 막혔으면 갈 수 있는 가장 먼 곳에 선다', () => {
    // 맵 가장자리 벽에 처박은 경우. 그래도 원래 자리보다 뒤로 가지는 않는다.
    const world = makeWorld(mapFromRows([
        '#####',
        '#...#',
        '#####',
    ]), [makePlayer(1, 1, 1, { loadout: SkillId.Flash, facingX: 1, facingY: 0 })]);

    const startX = world.players[0]!.x;
    use(world, { playerId: 1, slot: 2 });

    const p = world.players[0]!;
    assert.ok(p.x >= startX, '원래 자리보다 뒤로 갔다');
    assert.ok(p.x <= 4 * TEST_TILE_SIZE - p.radius + 0.001, `맵 밖으로 나갔다: x=${p.x}`);
});

test('점멸 뒤 좌표는 항상 유효하다', () => {
    // 벽을 넘게 만들면서 벽 속에 박히는 좌표가 생기면 안 된다. 여러 방향으로 확인한다.
    const rows = [
        '#########',
        '#.#.#.#.#',
        '#.......#',
        '#.#.#.#.#',
        '#.......#',
        '#########',
    ];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

    for (const [dx, dy] of dirs) {
        for (const [tx, ty] of [[1, 2], [3, 4], [5, 2], [7, 4]]) {
            const world = makeWorld(mapFromRows(rows), [
                makePlayer(1, tx!, ty!, { loadout: SkillId.Flash, facingX: dx!, facingY: dy! }),
            ]);
            use(world, { playerId: 1, slot: 2 });

            const p = world.players[0]!;
            const free = isPositionFree(world.map, p.x, p.y, p.radius, stormRect(world));
            assert.ok(free, `벽 속에 착지했다: dir=(${dx},${dy}) start=(${tx},${ty}) -> (${p.x},${p.y})`);
        }
    }
});

test('방향이 없으면 점멸을 쓸 수 없다', () => {
    const world = makeWorld(mapFromRows(OPEN), [
        makePlayer(1, 2, 2, { loadout: SkillId.Flash, facingX: 0, facingY: 0 }),
    ]);
    const { outcome } = use(world, { playerId: 1, slot: 2 });
    assert.deepEqual(outcome, { ok: false, reason: 'NO_TARGET' });
    assert.equal(world.players[0]!.cooldowns[SkillId.Flash], undefined, '못 쓴 스킬이 쿨타임을 먹었다');
});

/* ────────────────────────── 탈진 ────────────────────────── */

test('탈진은 사거리 안 가장 가까운 사람을 느리게 한다', () => {
    const world = makeWorld(mapFromRows(OPEN), [
        makePlayer(1, 2, 2, { loadout: SkillId.Exhaust }),
        makePlayer(2, 3, 2),
        makePlayer(3, 5, 2),
    ]);

    assert.equal(use(world, { playerId: 1, slot: 2 }).outcome.ok, true);
    assert.ok(world.players[1]!.effects[EffectType.Exhaust], '가까운 쪽이 안 걸렸다');
    assert.equal(world.players[2]!.effects[EffectType.Exhaust], undefined, '먼 쪽까지 걸렸다');
});

test('탈진은 진영을 가리지 않는다', () => {
    // 러너가 다른 러너를 탈진시킬 수 있다. 팀 게임이 아니라 개인전이다.
    const world = makeWorld(mapFromRows(OPEN), [
        makePlayer(1, 2, 2, { loadout: SkillId.Exhaust }),
        makePlayer(2, 3, 2),
        makePlayer(3, 5, 5, { isTagger: true }),
    ]);

    use(world, { playerId: 1, slot: 2 });
    assert.ok(world.players[1]!.effects[EffectType.Exhaust], '같은 러너에게 안 걸렸다');
});

test('탈진이 빗나가도 쿨타임은 소모된다', () => {
    const world = makeWorld(mapFromRows(OPEN), [makePlayer(1, 2, 2, { loadout: SkillId.Exhaust })]);
    const { outcome } = use(world, { playerId: 1, slot: 2 });
    assert.deepEqual(outcome, { ok: false, reason: 'OUT_OF_RANGE' });
    assert.ok((world.players[0]!.cooldowns[SkillId.Exhaust] ?? 0) > 0, '아무 데서나 눌러도 공짜면 안 된다');
});

/* ────────────────────────── 스위치 ────────────────────────── */

function switchWorld() {
    const tagger = makePlayer(1, 2, 2, { isTagger: true });
    // 술래 사거리 안에 붙은 시전자
    const caster = makePlayer(2, 2, 2, { x: 2.5 * TEST_TILE_SIZE + SKILLS.SWITCH.RANGE_PX * 0.8, y: 2.5 * TEST_TILE_SIZE });
    const faraway = makePlayer(3, 6, 5);
    return makeWorld(mapFromRows(OPEN), [tagger, caster, faraway]);
}

test('스위치는 지목한 러너를 술래로 만들고 기존 술래를 강등시킨다', () => {
    const world = switchWorld();
    const { outcome, events } = use(world, { playerId: 2, slot: 1, targetPlayerId: 3 });

    assert.equal(outcome.ok, true);
    assert.equal(world.players[2]!.isTagger, true, '지목당한 사람이 술래가 안 됐다');
    assert.equal(world.players[0]!.isTagger, false, '기존 술래가 강등되지 않았다');
    assert.equal(world.players[1]!.isTagger, false, '시전자는 러너로 남아야 한다');
    assert.ok(events.some((e) => e.kind === 'tagged' && e.playerId === 3));
});

test('지목 대상까지의 거리는 상관없다', () => {
    // 맵 반대편의 방심하던 사람이 갑자기 술래가 되는 순간이 이 스킬의 전부다.
    const world = switchWorld();
    const far = world.players[2]!;
    const caster = world.players[1]!;
    assert.ok(
        Math.hypot(far.x - caster.x, far.y - caster.y) > SKILLS.SWITCH.RANGE_PX * 2,
        '지목 대상이 스위치 사거리 밖에 있어야 이 테스트가 의미 있다',
    );

    assert.equal(use(world, { playerId: 2, slot: 1, targetPlayerId: 3 }).outcome.ok, true);
});

test('술래에게서 멀면 스위치가 실패하고 쿨타임만 먹는다', () => {
    const world = makeWorld(mapFromRows(OPEN), [
        makePlayer(1, 1, 1, { isTagger: true }),
        makePlayer(2, 6, 5),
        makePlayer(3, 6, 1),
    ]);
    const { outcome } = use(world, { playerId: 2, slot: 1, targetPlayerId: 3 });

    assert.deepEqual(outcome, { ok: false, reason: 'OUT_OF_RANGE' });
    assert.equal(world.players[0]!.isTagger, true, '실패했는데 술래가 바뀌었다');
    assert.ok((world.players[1]!.cooldowns[SkillId.Switch] ?? 0) > 0, '실패가 공짜면 계속 눌러보는 게 최적이 된다');
});

test('스위치 성공 시 새 술래와 시전자 모두 광란을 받는다', () => {
    const world = switchWorld();
    use(world, { playerId: 2, slot: 1, targetPlayerId: 3 });

    assert.ok(world.players[2]!.effects[EffectType.Frenzy], '새 술래에게 광란이 없다');
    assert.ok(world.players[1]!.effects[EffectType.Frenzy], '시전자에게 광란이 없다 — 도망칠 시간이 필요하다');
});

test('스위치로 강등된 술래는 감속을 받는다', () => {
    const world = switchWorld();
    use(world, { playerId: 2, slot: 1, targetPlayerId: 3 });

    const demoted = world.players[0]!;
    assert.ok(demoted.effects[EffectType.Exhaust], '강등된 술래가 멀쩡하다');
    assert.equal(demoted.effects[EffectType.Exhaust]!.magnitude, SKILLS.SWITCH_VICTIM.SPEED_DECREASE);
});

test('술래는 스위치를 쓸 수 없다', () => {
    const world = switchWorld();
    const { outcome } = use(world, { playerId: 1, slot: 1, targetPlayerId: 3 });
    assert.deepEqual(outcome, { ok: false, reason: 'NO_SKILL' }, '술래는 1번 슬롯이 비활성이다');
});

test('자기 자신이나 술래를 지목할 수 없다', () => {
    const a = switchWorld();
    assert.equal(use(a, { playerId: 2, slot: 1, targetPlayerId: 2 }).outcome.ok, false);

    const b = switchWorld();
    assert.equal(use(b, { playerId: 2, slot: 1, targetPlayerId: 1 }).outcome.ok, false);
});

test('탈락한 사람을 지목할 수 없다', () => {
    const world = switchWorld();
    world.players[2]!.alive = false;
    assert.deepEqual(use(world, { playerId: 2, slot: 1, targetPlayerId: 3 }).outcome, { ok: false, reason: 'NO_TARGET' });
});

/* ────────────────────────── 루프 통합 ────────────────────────── */

test('술래가 강제 교체되면 광란이 붙는다', () => {
    const world = makeWorld(mapFromRows(OPEN), [
        makePlayer(1, 1, 1, { isTagger: true }),
        makePlayer(2, 5, 1),
        makePlayer(3, 5, 5),
    ]);

    const ticks = msToTicks(GAMEPLAY.TAGGER_CHANGE_COOLDOWN_MS, world.simulationHz);
    for (let i = 0; i < ticks + 1; i++) stepWorld(world, []);

    const newTagger = world.players.find((p) => p.isTagger)!;
    assert.notEqual(newTagger.playerId, 1, '술래가 안 바뀌었다');
    assert.ok(newTagger.effects[EffectType.Frenzy], '새 술래에게 광란이 없다');
});

test('스킬 요청이 있어도 결정론이 유지된다', () => {
    const run = () => {
        const world = makeWorld(mapFromRows(OPEN), [
            makePlayer(1, 2, 2, { isTagger: true, loadout: SkillId.Dash }),
            makePlayer(2, 3, 2, { loadout: SkillId.Exhaust }),
            makePlayer(3, 5, 4, { loadout: SkillId.Flash }),
        ]);
        for (let i = 0; i < 200; i++) {
            const requests: SkillRequest[] = i % 40 === 0
                ? [{ playerId: 1, slot: 2 }, { playerId: 2, slot: 2 }, { playerId: 3, slot: 2 }]
                : [];
            stepWorld(world, [
                { playerId: 1, moveX: 1, moveY: 0, heldActions: 0, lastProcessedSequence: i },
                { playerId: 2, moveX: -1, moveY: 1, heldActions: 0, lastProcessedSequence: i },
                { playerId: 3, moveX: 0, moveY: -1, heldActions: 0, lastProcessedSequence: i },
            ], requests);
        }
        return JSON.stringify(world.players.map((p) => [p.playerId, p.x, p.y, p.isTagger, p.alive]));
    };

    assert.equal(run(), run());
});

test('유체화를 쓴 tick부터 실제로 빨라진다', () => {
    const world = makeWorld(mapFromRows(OPEN), [makePlayer(1, 1, 3, { loadout: SkillId.Dash })]);
    const input = { playerId: 1, moveX: 1, moveY: 0, heldActions: 0, lastProcessedSequence: 0 };

    const before = world.players[0]!.x;
    stepWorld(world, [input]);
    const normalStep = world.players[0]!.x - before;

    const dashBefore = world.players[0]!.x;
    stepWorld(world, [input], [{ playerId: 1, slot: 2 }]);
    const dashStep = world.players[0]!.x - dashBefore;

    assert.ok(dashStep > normalStep * 2.5, `눌렀는데 다음 tick부터 빨라졌다: ${normalStep} -> ${dashStep}`);
});
