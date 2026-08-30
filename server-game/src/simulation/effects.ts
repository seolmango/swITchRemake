/**
 * 상태 효과와 속도 계산.
 *
 * 효과는 서로 상쇄하거나 해제하지 않는다. 유체화가 걸린 사람에게 탈진을 걸면 유체화가 사라지는
 * 게 아니라 둘 다 붙어 있고, 계산식이 그 결과를 정한다. "이 스킬이 저 스킬을 지운다"는 규칙을
 * 만들기 시작하면 조합마다 예외가 생긴다.
 */

import { EffectType } from 'shared';
import { GAMEPLAY, SPEED } from '../config/gameplay';
import type { PlayerState, World } from './world';

/** 속도를 올리는 효과. 나머지는 내린다. */
const INCREASE_EFFECTS: readonly EffectType[] = [EffectType.Dash, EffectType.Frenzy];

function isIncrease(type: EffectType): boolean {
    return INCREASE_EFFECTS.includes(type);
}

export function msToTicks(ms: number, simulationHz: number): number {
    return Math.max(1, Math.round((ms / 1000) * simulationHz));
}

/**
 * 효과를 건다.
 *
 * **같은 타입은 중첩되지 않고 갱신된다.** 탈진을 두 번 맞아 속도가 0이 되는 상황을 막는다.
 * 갱신할 때는 더 강한 크기와 더 늦은 종료 시점을 각각 취한다. 약한 효과가 강한 효과를 덮어써
 * 이득이 되는 일이 없어야 한다. 스위치 감속(-10%)이 탈진(-40%)을 지우면 맞는 쪽이 이득이다.
 */
export function applyEffect(world: World, player: PlayerState, type: EffectType, magnitude: number, durationMs: number): void {
    const endTick = world.tick + msToTicks(durationMs, world.simulationHz);
    const existing = player.effects[type];

    player.effects[type] = existing
        ? { endTick: Math.max(existing.endTick, endTick), magnitude: Math.max(existing.magnitude, magnitude) }
        : { endTick, magnitude };
}

/** 만료된 효과를 제거한다. 매 tick 이동 계산 전에 부른다. */
export function expireEffects(world: World, player: PlayerState): void {
    for (const key of Object.keys(player.effects) as EffectType[]) {
        const effect = player.effects[key];
        if (effect && effect.endTick <= world.tick) delete player.effects[key];
    }
}

/**
 * 현재 이동 속도(px/초).
 *
 *   BASE × (1 + Σincrease) × max(FLOOR, 1 − Σdecrease)
 *
 * 증가군과 감소군을 따로 더한 뒤 곱한다. 하나의 덧셈 풀이면 유체화(+2.0)와 탈진(-0.4)이
 * 1.6배로 끝나 탈진이 사실상 무의미해지고, 반대로 크기가 비슷할 때는 정확히 상쇄돼 탈진이
 * 유체화를 "해제"한 것처럼 보인다. 군을 곱하면 둘 다 유지되면서 결과만 달라진다.
 */
export function currentSpeed(player: PlayerState): number {
    let increase = 0;
    let decrease = 0;

    for (const key of Object.keys(player.effects) as EffectType[]) {
        const effect = player.effects[key];
        if (!effect) continue;
        if (isIncrease(key)) increase += effect.magnitude;
        else decrease += effect.magnitude;
    }

    const slowFactor = Math.max(SPEED.DECREASE_FLOOR, 1 - decrease);
    return GAMEPLAY.BASE_MOVE_SPEED_PX_PER_SEC * (1 + increase) * slowFactor;
}

/**
 * 쿨타임을 tick 단위로 깎는다.
 *
 * 술래는 두 배로 빨리 찬다. 레거시가 매 tick 2씩 깎았고(레거시 `main.js:275`),
 * 쫓는 쪽이 스킬을 더 자주 써야 추격이 성립한다.
 */
/**
 * 쿨타임을 tick 단위로 깎는다.
 *
 * `rate`는 회복 배수다. 호출자가 "이 사람이 지금 얼마나 빨리 회복하는가"를 정해서 넘긴다 —
 * 술래인지 근처에 누가 있는지는 효과 계층이 알 일이 아니다.
 */
export function tickCooldowns(player: PlayerState, rate = 1): void {
    const step = rate;
    for (const key of Object.keys(player.cooldowns)) {
        const remaining = (player.cooldowns[key] ?? 0) - step;
        if (remaining <= 0) delete player.cooldowns[key];
        else player.cooldowns[key] = remaining;
    }
}

export function isReady(player: PlayerState, skill: string): boolean {
    return (player.cooldowns[skill] ?? 0) <= 0;
}

export function startCooldown(world: World, player: PlayerState, skill: string, cooldownMs: number): void {
    player.cooldowns[skill] = msToTicks(cooldownMs, world.simulationHz);
}
