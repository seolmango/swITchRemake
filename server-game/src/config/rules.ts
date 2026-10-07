/**
 * 규칙(밸런스) 버전.
 *
 * 경기 결과·리플레이·heartbeat에 찍히는 `RULES_VERSION`은 사람이 손으로 올리지 않는다. 밸런스 값 전체를
 * 평평한 표로 만든 뒤 그 지문을 `rules-lock.ts`(마지막 릴리스)와 비교한다.
 *
 * - 같으면 lock의 버전 그대로: `0.5.0`
 * - 다르면 아직 릴리스하지 않은 실험이다: `0.5.0-dev.1a2b3c4d`. 로컬에서 숫자를 바꿔 훈련장에서
 *   시험한 경기가 정식 버전으로 기록되지 않는다.
 *
 * 값을 바꿨으면 `npm run balance:release`가 버전을 올리고 업데이트 기록(CHANGELOG.md)을 쓴다.
 * 그러지 않으면 `rules.test.ts`가 실패한다. 시뮬레이션 코드(`simulation/`)를 고쳐도 마찬가지다 —
 * 숫자가 같아도 물리가 달라지면 다른 규칙이다.
 */

import { createHash } from 'node:crypto';
import { MOVEMENT, PROGRESSION, SKILL_TUNING, SPEED_DECREASE_FLOOR, TILE_PX } from 'shared';
import { EMOJI_DISPLAY_MS, GAMEPLAY, SKILLS, SPEED } from './gameplay';
import { NETWORK } from './network';
import { RULES_LOCK } from './rules-lock';

type Scalar = number | string | boolean;

function flatten(prefix: string, value: unknown, out: Record<string, Scalar>): void {
    if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value).sort()) flatten(`${prefix}.${key}`, (value as Record<string, unknown>)[key], out);
    } else if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
        out[prefix] = value;
    }
}

/**
 * 경기 결과를 바꿀 수 있는 값 전부. 키는 코드에서 찾을 수 있는 이름이다(예: `SKILL_TUNING.DASH_COOLDOWN_MS`).
 *
 * 서버 쪽 `GAMEPLAY`·`SKILLS`에는 `SKILL_TUNING`에서 단위만 바꾼 값도 들어 있어 한 번 바꾸면 두 줄이
 * 함께 바뀔 수 있다. 빠뜨리는 것보다 겹치는 편이 낫다.
 */
export function balanceValues(): Record<string, Scalar> {
    const out: Record<string, Scalar> = {};
    flatten('MOVEMENT', MOVEMENT, out);
    flatten('SKILL_TUNING', SKILL_TUNING, out);
    flatten('SPEED_DECREASE_FLOOR', SPEED_DECREASE_FLOOR, out);
    flatten('TILE_PX', TILE_PX, out);
    flatten('PROGRESSION', PROGRESSION, out);
    flatten('GAMEPLAY', GAMEPLAY, out);
    flatten('SKILLS', SKILLS, out);
    flatten('SPEED', SPEED, out);
    flatten('EMOJI_DISPLAY_MS', EMOJI_DISPLAY_MS, out);
    flatten('NETWORK.SIMULATION_HZ', NETWORK.SIMULATION_HZ, out);
    return out;
}

export function balanceHash(values: Record<string, Scalar> = balanceValues()): string {
    const stable = JSON.stringify(Object.keys(values).sort().map((key) => [key, values[key]]));
    return createHash('sha256').update(stable).digest('hex');
}

export function rulesVersion(hash: string = balanceHash()): string {
    return hash === RULES_LOCK.valuesHash ? RULES_LOCK.version : `${RULES_LOCK.version}-dev.${hash.slice(0, 8)}`;
}

/** 밸런스가 바뀌면 바뀐다. 경기 결과와 리플레이에 함께 기록되어 "그 경기가 어떤 규칙이었는지"를 남긴다. */
export const RULES_VERSION = rulesVersion();
