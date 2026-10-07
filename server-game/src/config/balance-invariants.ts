/**
 * 밸런스를 바꿔도 깨지면 안 되는 관계(BASE.md §2.3, §2.5, §2.1).
 *
 * 숫자 자체는 마음대로 바꿔도 되지만, 아래 관계가 깨지면 스킬이 서로를 대체하거나 경기가 성립하지
 * 않는다. `rules.test.ts`와 `npm run balance`가 같은 목록을 쓴다. 관계를 일부러 바꾸려면 BASE.md를
 * 먼저 고치고 여기를 고친다.
 */

import { MOVEMENT, SKILL_TUNING, SPEED_DECREASE_FLOOR, TILE_PX } from 'shared';
import { GAMEPLAY } from './gameplay';

export interface InvariantResult {
    readonly name: string;
    readonly ok: boolean;
    /** 판정에 쓴 실제 값. 실패했을 때 무엇을 고쳐야 하는지 보이게 한다. */
    readonly detail: string;
}

const check = (name: string, ok: boolean, detail: string): InvariantResult => ({ name, ok, detail });

export function balanceInvariants(): InvariantResult[] {
    const t = SKILL_TUNING;
    const dashExtraTiles = t.DASH_SPEED_INCREASE * MOVEMENT.BASE_SPEED_TILES_PER_SEC * (t.DASH_DURATION_MS / 1000);
    return [
        check(
            '유체화가 같은 시간에 점멸보다 멀리 간다',
            dashExtraTiles > t.FLASH_DISTANCE_TILES,
            `유체화 추가 이동 ${dashExtraTiles.toFixed(2)}타일 vs 점멸 ${t.FLASH_DISTANCE_TILES}타일`,
        ),
        check(
            '쿨타임은 점멸 < 유체화 < 탈진',
            t.FLASH_COOLDOWN_MS < t.DASH_COOLDOWN_MS && t.DASH_COOLDOWN_MS < t.EXHAUST_COOLDOWN_MS,
            `점멸 ${t.FLASH_COOLDOWN_MS} / 유체화 ${t.DASH_COOLDOWN_MS} / 탈진 ${t.EXHAUST_COOLDOWN_MS} ms`,
        ),
        check(
            '탈진의 자기 감속은 남에게 거는 것보다 짧고 얕다',
            t.EXHAUST_SELF_DECREASE < t.EXHAUST_SPEED_DECREASE && t.EXHAUST_SELF_DURATION_MS < t.EXHAUST_DURATION_MS,
            `자기 ${t.EXHAUST_SELF_DECREASE}·${t.EXHAUST_SELF_DURATION_MS}ms vs 남 ${t.EXHAUST_SPEED_DECREASE}·${t.EXHAUST_DURATION_MS}ms`,
        ),
        check(
            '감속 바닥은 0과 1 사이(효과가 겹쳐도 속도가 0이 되지 않는다)',
            SPEED_DECREASE_FLOOR > 0 && SPEED_DECREASE_FLOOR < 1,
            `바닥 ${SPEED_DECREASE_FLOOR}`,
        ),
        check(
            '최소 3명, 최대 8명이고 승리 인원은 시작 인원보다 적다',
            GAMEPLAY.MIN_PLAYERS_TO_START === 3 && GAMEPLAY.MAX_PLAYERS === 8 && GAMEPLAY.SURVIVORS_TO_WIN < GAMEPLAY.MIN_PLAYERS_TO_START,
            `시작 ${GAMEPLAY.MIN_PLAYERS_TO_START}~${GAMEPLAY.MAX_PLAYERS}명, 승리 ${GAMEPLAY.SURVIVORS_TO_WIN}명 이하`,
        ),
        check(
            '근접 쿨감은 0보다 크다(도망자가 술래 곁에 머물 이유)',
            t.NEAR_TAGGER_COOLDOWN_BONUS > 0 && t.NEAR_TAGGER_RADIUS_TILES > 0,
            `보너스 ${t.NEAR_TAGGER_COOLDOWN_BONUS}, 반경 ${t.NEAR_TAGGER_RADIUS_TILES}타일`,
        ),
        check(
            '스위치는 붙어야 쓸 수 있다(사거리가 시야보다 훨씬 짧다)',
            t.SWITCH_RANGE_TILES * 4 < GAMEPLAY.SIGHT_RANGE_PX / TILE_PX,
            `스위치 사거리 ${t.SWITCH_RANGE_TILES}타일, 시야 폭 ${GAMEPLAY.SIGHT_RANGE_PX / TILE_PX}타일`,
        ),
    ];
}
