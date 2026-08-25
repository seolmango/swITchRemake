/**
 * 스킬 판정. 전부 서버가 정한다.
 *
 * 클라이언트가 보내는 것은 "이 슬롯을 쓰겠다"는 요청과, 스위치의 경우 지목 대상뿐이다.
 * 쿨타임이 찼는지, 사거리 안인지, 그래서 무슨 일이 일어나는지는 전부 여기서 결정한다.
 * 클라이언트 HUD의 쿨타임 표시는 서버가 내려준 값을 그리는 것이고 판정 근거가 아니다.
 */

import { EffectType, LOADOUT_SKILLS, SkillId, SkillRejection, SkillSlot, isLoadoutSkill } from 'shared';
import { SKILLS } from '../config/gameplay';
import { applyEffect, isReady, startCooldown } from './effects';
import { isPositionFree } from './static-collision';
import { stormRect } from './storm';
import type { PlayerState, World, WorldEvent } from './world';

/**
 * 스킬 식별자와 로드아웃 집합은 `shared`가 원본이다. 클라이언트의 선택 UI와 매칭 서버의 로비 중계가
 * 같은 값을 봐야 하는데, 여기 두면 그쪽이 복사본을 갖게 된다. 실제로 그래서 `lobby.setLoadout`이
 * 무조건 거부되고 있었다. 기존 import 경로를 깨지 않으려고 여기서 다시 내보낸다.
 */
export { SkillId, LOADOUT_SKILLS, isLoadoutSkill };

/** 스킬 사용 요청. `targetPlayerId`는 스위치에만 쓰인다. */
export interface SkillRequest {
    playerId: number;
    slot: number;
    targetPlayerId?: number;
}

export type SkillOutcome =
    | { ok: true; skill: SkillId }
    | { ok: false; reason: SkillRejection };

function livingRunners(world: World, exceptId?: number): PlayerState[] {
    return world.players
        .filter((p) => p.alive && !p.isTagger && p.playerId !== exceptId)
        .sort((a, b) => a.playerId - b.playerId);
}

function distance(a: PlayerState, b: PlayerState): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 술래가 된 사람에게 붙는 광란. 경기 시작·강제 교체·스위치 지목 모두 같은 취급이다. */
export function grantTaggerFrenzy(world: World, player: PlayerState): void {
    applyEffect(world, player, EffectType.Frenzy, SKILLS.FRENZY.SPEED_INCREASE, SKILLS.FRENZY.DURATION_MS);
}

/**
 * 유체화. 역할과 무관하게 쓴다. 자기 자신의 속도만 올린다.
 * 레거시의 `Boost`가 이것이다 — 코드 주석은 점멸이라고 적었지만 실제로는 지속 속도 버프였다.
 */
function useDash(world: World, caster: PlayerState): SkillOutcome {
    applyEffect(world, caster, EffectType.Dash, SKILLS.DASH.SPEED_INCREASE, SKILLS.DASH.DURATION_MS);
    startCooldown(world, caster, SkillId.Dash, SKILLS.DASH.COOLDOWN_MS);
    return { ok: true, skill: SkillId.Dash };
}

/**
 * 점멸. 바라보는 방향으로 순간이동하며 **벽을 넘는다.**
 *
 * 벽을 못 넘으면 유체화와 밸런스가 맞지 않는다. 유체화는 1초 동안 계속 달려 더 먼 거리를 벌 수
 * 있으므로, 점멸의 값어치는 "거리"가 아니라 "벽 너머로 간다"에 있어야 한다.
 *
 * 착지점이 벽 속이면 **진행 방향으로 계속 밀어 벽 바깥으로 내보낸다.** 뒤로 되돌리면 "썼는데
 * 제자리"가 되어 플레이어 입장에서 불쾌하다. 애매한 상황은 쓴 사람에게 유리하게 푼다.
 *
 * 앞으로도 나갈 곳이 없을 때만(맵 가장자리 벽에 처박은 경우 등) 뒤로 물러서며 유효한 지점을
 * 찾는다. 이 경우에도 원래 자리보다 뒤로 가지는 않는다.
 *
 * 방향이 없으면(가만히 서 있어 facing이 0) 쓸 수 없다. 제자리 점멸은 쿨타임만 버리는 조작 실수다.
 */
function useFlash(world: World, caster: PlayerState, events: WorldEvent[]): SkillOutcome {
    const len = Math.hypot(caster.facingX, caster.facingY);
    if (len === 0) return { ok: false, reason: 'NO_TARGET' };

    const dirX = caster.facingX / len;
    const dirY = caster.facingY / len;
    const fromX = caster.x;
    const fromY = caster.y;
    const storm = stormRect(world);

    const free = (x: number, y: number): boolean => isPositionFree(world.map, x, y, caster.radius, storm);

    const landing = findFlashLanding(
        fromX, fromY, dirX, dirY,
        SKILLS.FLASH.DISTANCE_PX, SKILLS.FLASH.WALL_EXIT_MAX_PX, caster.radius,
        free,
    );

    caster.x = landing.x;
    caster.y = landing.y;

    startCooldown(world, caster, SkillId.Flash, SKILLS.FLASH.COOLDOWN_MS);
    events.push({ kind: 'blinked', playerId: caster.playerId, fromX, fromY });
    return { ok: true, skill: SkillId.Flash };
}

/**
 * 착지점을 고른다. 경로 중간의 벽은 무시하고, 목표 지점부터 판정한다.
 *
 * 1. 목표 지점이 비었으면 거기.
 * 2. 아니면 진행 방향으로 조금씩 더 나아가며 처음 비는 곳. (쓴 사람에게 유리)
 * 3. 그래도 없으면 목표 지점에서 출발점 쪽으로 물러나며 처음 비는 곳.
 * 4. 전부 실패하면 제자리.
 *
 * 탐색 간격은 반지름의 절반이다. 이보다 성기면 원이 들어갈 수 있는 좁은 틈을 지나칠 수 있다.
 */
function findFlashLanding(
    fromX: number,
    fromY: number,
    dirX: number,
    dirY: number,
    distance: number,
    maxOvershoot: number,
    radius: number,
    free: (x: number, y: number) => boolean,
): { x: number; y: number } {
    const targetX = fromX + dirX * distance;
    const targetY = fromY + dirY * distance;
    if (free(targetX, targetY)) return { x: targetX, y: targetY };

    const stepLen = Math.max(1, radius / 2);

    // 앞으로 밀어 벽 바깥으로 빼낸다.
    for (let travelled = stepLen; travelled <= maxOvershoot; travelled += stepLen) {
        const x = targetX + dirX * travelled;
        const y = targetY + dirY * travelled;
        if (free(x, y)) return { x, y };
    }

    // 앞이 막혔다. 목표 지점에서 뒤로 물러나며 갈 수 있는 가장 먼 곳을 찾는다.
    for (let travelled = stepLen; travelled <= distance; travelled += stepLen) {
        const x = targetX - dirX * travelled;
        const y = targetY - dirY * travelled;
        if (free(x, y)) return { x, y };
    }

    return { x: fromX, y: fromY };
}

/**
 * 탈진. 사거리 안의 **모두**를 느리게 만든다.
 *
 * **진영을 보지 않는다.** 러너가 다른 러너를 탈진시킬 수 있다. 팀 게임이 아니라 개인전이며,
 * 옆사람을 느리게 만드는 것이 나에게 이득인 구조가 의도된 설계다. 여기에 팀 필터를 넣지 않는다.
 *
 * 사거리 안의 **모두**가 걸린다. 지목이 없으므로 조준이 아니라 위치 선정이 이 스킬의 기술이다.
 */
function useExhaust(world: World, caster: PlayerState, events: WorldEvent[]): SkillOutcome {
    // 지목기가 아니라 **범위기**다. 사거리 안의 사람은 술래든 러너든 전부 걸린다.
    // playerId 오름차순으로 도는 것은 결정론 때문이다 — 효과 적용 순서가 바뀌면 리플레이가 달라진다.
    const hits = world.players
        .filter((p) => p.alive && p.playerId !== caster.playerId && distance(caster, p) <= SKILLS.EXHAUST.RANGE_PX)
        .sort((a, b) => a.playerId - b.playerId);

    // 사거리 원은 아무도 안 걸려도 그린다. 어디서 얼마만큼의 범위를 폈는지가 주변 사람에게 정보다.
    // 지목한 상대가 없으므로 대상도 싣지 않는다 — 원의 색은 시전자에게서 온다.
    events.push({
        kind: 'skillArea',
        skillId: SkillId.Exhaust,
        playerId: caster.playerId,
        fromX: caster.x,
        fromY: caster.y,
    });

    startCooldown(world, caster, SkillId.Exhaust, SKILLS.EXHAUST.COOLDOWN_MS);
    // 빗나가도 쿨타임은 돈다. 아무 데서나 눌러보는 것을 막는다.
    if (hits.length === 0) return { ok: false, reason: 'OUT_OF_RANGE' };

    for (const hit of hits) {
        applyEffect(world, hit, EffectType.Exhaust, SKILLS.EXHAUST.SPEED_DECREASE, SKILLS.EXHAUST.DURATION_MS);
    }
    return { ok: true, skill: SkillId.Exhaust };
}

/**
 * 스위치. 이 게임의 이름이 여기서 왔다.
 *
 * 발동 조건은 **현재 술래와의 거리**뿐이다. 지목 대상은 살아 있는 다른 러너라면 맵 어디에 있어도
 * 된다. 거리가 상관없다는 게 핵심이다 — 맵 반대편에서 방심하던 사람이 갑자기 술래가 되는 순간을
 * 만들기 위한 스킬이다.
 *
 * 결과: 지목당한 러너 → 새 술래(광란), 기존 술래 → 러너(감속), 시전자 → 러너 유지(광란).
 * 시전자가 러너로 남으면서 광란을 받는 이유는, 술래 바로 옆에서 썼기 때문에 도망칠 시간이
 * 필요해서다.
 */
function useSwitch(world: World, caster: PlayerState, targetPlayerId: number | undefined, events: WorldEvent[]): SkillOutcome {
    if (caster.isTagger) return { ok: false, reason: 'ROLE' };

    const tagger = world.players.find((p) => p.isTagger && p.alive);
    if (!tagger) return { ok: false, reason: 'NO_TARGET' };

    const target = world.players.find((p) => p.playerId === targetPlayerId);
    const targetValid = target !== undefined && target.alive && !target.isTagger && target.playerId !== caster.playerId;

    // 사거리 밖이거나 지목이 잘못돼도 쿨타임은 소모한다. 실패가 공짜면 계속 눌러보는 게 최적이 된다.
    startCooldown(world, caster, SkillId.Switch, SKILLS.SWITCH.COOLDOWN_MS);
    caster.stats.switchTry += 1;

    // 사거리 판정보다 먼저 남긴다. 실패한 시도도 화면에 보여야 한다 — 어디서 누구를 노렸는지가
    // 주변 사람에게 정보이고, 레거시도 누를 때마다 원을 그렸다(Engine.js의 skill.type 1~8).
    events.push({
        kind: 'skillArea',
        skillId: SkillId.Switch,
        playerId: caster.playerId,
        fromX: caster.x,
        fromY: caster.y,
        ...(targetPlayerId === undefined ? {} : { targetPlayerId }),
    });

    if (distance(caster, tagger) > SKILLS.SWITCH.RANGE_PX) return { ok: false, reason: 'OUT_OF_RANGE' };
    if (!targetValid) return { ok: false, reason: 'NO_TARGET' };

    tagger.isTagger = false;
    applyEffect(world, tagger, EffectType.Exhaust, SKILLS.SWITCH_VICTIM.SPEED_DECREASE, SKILLS.SWITCH_VICTIM.DURATION_MS);

    target.isTagger = true;
    grantTaggerFrenzy(world, target);
    world.taggerChangedAtTick = world.tick;

    grantTaggerFrenzy(world, caster);
    caster.stats.switchSuccess += 1;

    events.push({ kind: 'tagged', playerId: target.playerId, by: caster.playerId });
    return { ok: true, skill: SkillId.Switch };
}

/**
 * 슬롯 번호를 실제 스킬로 바꾼다.
 * 1번은 스위치 고정, 2번은 경기 전에 고른 스킬이다. 술래는 1번 슬롯이 비활성이다.
 */
export function skillInSlot(player: PlayerState, slot: number): SkillId | null {
    if (slot === SkillSlot.Switch) return player.isTagger ? null : SkillId.Switch;
    if (slot === SkillSlot.Movement) return player.loadout;
    return null;
}

/** 스킬 사용 요청 하나를 처리한다. 실패해도 예외를 던지지 않는다. */
export function useSkill(world: World, request: SkillRequest, events: WorldEvent[]): SkillOutcome {
    const caster = world.players.find((p) => p.playerId === request.playerId);
    if (!caster || !caster.alive) return { ok: false, reason: 'NOT_ALIVE' };

    const skill = skillInSlot(caster, request.slot);
    if (skill === null) return { ok: false, reason: 'NO_SKILL' };
    if (!isReady(caster, skill)) return { ok: false, reason: 'ON_COOLDOWN' };

    switch (skill) {
        case SkillId.Dash: return useDash(world, caster);
        case SkillId.Flash: return useFlash(world, caster, events);
        case SkillId.Exhaust: return useExhaust(world, caster, events);
        case SkillId.Switch: return useSwitch(world, caster, request.targetPlayerId, events);
    }
}

/** 강제 술래 교체 대상 후보. 결정론을 위해 정렬된 목록을 준다. */
export function rotationCandidates(world: World): PlayerState[] {
    return livingRunners(world);
}
