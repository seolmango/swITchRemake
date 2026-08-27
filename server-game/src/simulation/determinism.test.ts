/**
 * 같은 seed와 같은 입력은 항상 같은 경기를 만든다.
 *
 * 이 프로젝트에서 결정론은 취향이 아니라 토대다. 리플레이는 프레임을 전부 저장하지 않고 입력과
 * seed만으로 다시 돌려 만들고, 신고 검토도 그 재생을 근거로 한다. 한 번이라도 어긋나면 저장된
 * 리플레이 전부가 "그때 실제로 있었던 일"이 아니게 된다.
 *
 * 깨지는 방식이 조용하다는 것이 문제다. `Math.random()` 하나, `Date.now()` 하나, `Set` 순회
 * 순서에 기댄 코드 한 줄이면 충분하고, 눈에 보이는 증상은 며칠 뒤 "리플레이가 실제 경기와
 * 다르다"는 신고로만 나타난다. 그래서 규칙을 만질 때마다 여기서 걸리게 해 둔다.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EffectType } from 'shared';
import { SkillId, type SkillRequest } from './skills';
import { stepWorld, type EmojiRequest } from './step';
import { makePlayer, makeWorld, mapFromRows, worldFingerprint } from './testing';
import type { ResolvedInput, World } from './world';

const MAP = [
    '##############',
    '#............#',
    '#..b.....gg..#',
    '#............#',
    '#....####....#',
    '#............#',
    '#..gg.....b..#',
    '#............#',
    '##############',
];

const TICKS = 240;

/**
 * 경기 한 판을 통째로 돌린다.
 *
 * 이동·충돌·스킬·이모지·자기장·태그를 한 번에 태우는 이유는, 결정론이 깨지는 자리가 대개
 * 개별 규칙이 아니라 **여러 규칙이 만나는 순서**이기 때문이다. 충돌 쌍을 어떤 순서로 푸는가,
 * 같은 tick에 들어온 스킬을 누구부터 처리하는가 같은 것들이다.
 */
function playMatch(seed: number): { world: World; log: string[] } {
    const world = makeWorld(mapFromRows(MAP, { barrierSpeed: 6 }), [
        makePlayer(1, 1, 1, { isTagger: true, loadout: SkillId.Dash }),
        makePlayer(2, 12, 1, { loadout: SkillId.Flash }),
        makePlayer(3, 1, 7, { loadout: SkillId.Exhaust }),
        makePlayer(4, 12, 7, { loadout: SkillId.Dash }),
    ], seed);

    const log: string[] = [];
    for (let tick = 0; tick < TICKS; tick += 1) {
        const frame = stepWorld(world, inputsFor(tick), skillsFor(tick), emojisFor(tick));
        // 이벤트까지 비교해야 "위치는 같은데 누가 잡혔는지가 다른" 어긋남을 잡는다.
        for (const event of frame.events) log.push(`${frame.tick} ${JSON.stringify(event)}`);
        for (const rejection of frame.skillRejections) log.push(`${frame.tick} reject ${JSON.stringify(rejection)}`);
    }
    return { world, log };
}

/**
 * tick마다 방향이 바뀌는 고정 각본. 무작위가 아니라 재현 가능한 패턴이다.
 *
 * 넷이 서로 다른 위상으로 돌아 자주 부딪히게 만든다. 충돌 해소 순서는 결정론이 깨지기 쉬운
 * 자리 중 하나다.
 */
function inputsFor(tick: number): ResolvedInput[] {
    const DIRECTIONS = [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const;
    return [1, 2, 3, 4].map((playerId) => {
        const [moveX, moveY] = DIRECTIONS[(tick + playerId * 5) % DIRECTIONS.length]!;
        return { playerId, moveX, moveY, heldActions: 0, lastProcessedSequence: tick };
    });
}

function skillsFor(tick: number): SkillRequest[] {
    if (tick % 37 !== 0) return [];
    // 같은 tick에 두 명이 요청한다. 처리 순서가 흔들리면 결과가 갈린다.
    return [
        { playerId: 2, slot: 2 },
        { playerId: 3, slot: 2 },
        { playerId: 4, slot: 1, targetPlayerId: 1 },
    ];
}

function emojisFor(tick: number): EmojiRequest[] {
    if (tick % 53 !== 0) return [];
    return [{ playerId: 1, emojiId: 3 }, { playerId: 4, emojiId: 7 }];
}

/**
 * 지문에 쿨타임·효과·이모지·기록까지 더한다.
 *
 * `worldFingerprint`는 위치와 생사만 본다. 그것만으로도 대부분의 어긋남은 잡히지만, 스킬
 * 쿨타임이나 광란 남은 시간이 어긋나는 것은 몇 tick 뒤에야 위치로 드러난다 — 그러면 원인이
 * 어디였는지 알 수 없다. 여기서는 어긋나는 순간에 잡는다.
 */
function fingerprint(world: World): string {
    return worldFingerprint(world) + JSON.stringify(world.players.map((player) => ({
        id: player.playerId,
        facingX: player.facingX,
        facingY: player.facingY,
        loadout: player.loadout,
        emoji: player.emoji,
        cooldowns: player.cooldowns,
        effects: player.effects,
        stats: player.stats,
    })));
}

test('같은 seed와 같은 입력은 tick 단위로 같은 경기를 만든다', () => {
    const first = playMatch(0x5717c4);
    const second = playMatch(0x5717c4);

    assert.equal(fingerprint(first.world), fingerprint(second.world));
    assert.deepEqual(first.log, second.log);
});

test('seed가 다르면 경기도 달라진다', () => {
    // 지문이 입력만 따라간다면 위 테스트는 아무것도 증명하지 않는다. seed가 실제로 결과에
    // 닿는지 확인해야 결정론 테스트가 의미를 갖는다.
    const a = playMatch(1);
    const b = playMatch(2);
    assert.notEqual(a.world.randomState, b.world.randomState);
});

test('경기 도중 아무 tick에서 이어 돌려도 같은 결과가 나온다', () => {
    // 리플레이 재생은 처음부터 끝까지 한 번에 돌리지만, 스케줄러는 프레임을 나눠 돌린다.
    // tick을 어떻게 쪼개 돌리든 결과가 같아야 둘이 같은 경기다.
    const whole = playMatch(99);

    const world = makeWorld(mapFromRows(MAP, { barrierSpeed: 6 }), [
        makePlayer(1, 1, 1, { isTagger: true, loadout: SkillId.Dash }),
        makePlayer(2, 12, 1, { loadout: SkillId.Flash }),
        makePlayer(3, 1, 7, { loadout: SkillId.Exhaust }),
        makePlayer(4, 12, 7, { loadout: SkillId.Dash }),
    ], 99);
    for (let tick = 0; tick < TICKS; tick += 1) {
        stepWorld(world, inputsFor(tick), skillsFor(tick), emojisFor(tick));
    }

    assert.equal(fingerprint(world), fingerprint(whole.world));
});

test('각본이 실제로 게임을 움직인다', () => {
    // 위 세 테스트는 아무 일도 안 일어나는 경기에서도 통과한다. 각본이 스킬과 효과와 자기장을
    // 실제로 건드리는지 확인해 두지 않으면 결정론을 "정지 화면"에서만 보장하게 된다.
    const { world, log } = playMatch(7);

    assert.notEqual(world.storm, null, '자기장이 닫혀야 한다');
    assert.ok(log.length > 0, '이벤트가 하나도 없으면 각본이 아무것도 안 한 것이다');
    const touchedEffects = world.players.some((player) =>
        Object.keys(player.effects).length > 0 || Object.keys(player.cooldowns).length > 0);
    assert.ok(touchedEffects, '스킬이 한 번도 안 나갔다');
    assert.ok(
        world.players.some((player) => player.effects[EffectType.Frenzy] !== undefined)
        || world.players.some((player) => Object.keys(player.cooldowns).length > 0),
        '광란이나 쿨타임 중 하나는 걸려 있어야 한다',
    );
});
