/**
 * 한 tick 진행. BASE.md §6.1의 게임 루프가 순서의 원본이다.
 *
 * 이 파일에서 지켜야 하는 두 가지:
 *
 *  1. **결정론.** `Date.now()`나 `Math.random()`을 부르지 않는다. 무작위가 필요하면 world의 seed로
 *     만든 PRNG를 쓴다. 이게 깨지면 리플레이가 같은 경기를 재현하지 못하고, 회귀 테스트도 못 짠다.
 *  2. **연결 무지.** 반환하는 `AuthoritativeFrame`은 연결을 모르는 단일 상태다. 누가 무엇을 보는지는
 *     이 함수가 끝난 뒤 시야 코어가 뷰어별로 판단한다.
 */

import { EffectType } from 'shared';
import { EMOJI_DISPLAY_MS, GAMEPLAY, SKILLS } from '../config/gameplay';
import { applyEffect, expireEffects, msToTicks, tickCooldowns } from './effects';
import { integrate, substepCount } from './movement';
import { grantTaggerFrenzy, rotationCandidates, useSkill, type SkillRequest } from './skills';
import { resolvePlayerCollisions, type CollisionPair } from './player-collision';
import { resolveStatic } from './static-collision';
import { stormRect } from './storm';
import type { AuthoritativeFrame, PlayerState, ResolvedInput, World, WorldEvent } from './world';

export interface EmojiRequest {
    readonly playerId: number;
    readonly emojiId: number;
}

/** 이번 tick의 맵 변경을 적용한다. timeline에 해당 tick이 없으면 아무 일도 하지 않는다. */
function applyMapTimeline(world: World): void {
    const changes = world.map.timeline[world.tick];
    if (!changes) return;

    for (const [x, y, physics] of changes) {
        const row = world.map.tiles[y];
        if (!row || row[x] === undefined) continue;
        row[x] = physics;
        world.tileChanges.push({ x, y, physics });
    }
}

/**
 * 술래 접촉 판정.
 *
 * **최종 분리 거리를 보지 않고 이번 tick에 발생한 collision pair를 본다.** 충돌 해결이 두 원을
 * 정확히 떼어놓은 뒤 거리를 재면 항상 "닿지 않음"이 나온다. 그러면 술래가 아무도 잡지 못한다.
 */
/**
 * 광란 중에 아웃시키면 광란이 길어지고 속도가 더 붙는다.
 *
 * 잘 잡는 술래가 점점 빨라져서 추격이 늘어지지 않게 하는 장치다. **광란이 이미 붙어 있을 때만**
 * 누적된다 — 광란이 끊긴 뒤에 잡았다면 그건 이어 온 추격이 아니라 새로 시작한 추격이다.
 */
function extendFrenzyOnTag(world: World, tagger: PlayerState): void {
    const current = tagger.effects[EffectType.Frenzy];
    if (current === undefined) return;
    const remainingMs = Math.max(0, current.endTick - world.tick) * (1_000 / world.simulationHz);
    applyEffect(
        world, tagger, EffectType.Frenzy,
        current.magnitude + SKILLS.FRENZY.TAG_BONUS_INCREASE,
        remainingMs + SKILLS.FRENZY.TAG_BONUS_MS,
    );
}

function resolveTagging(world: World, pairs: readonly CollisionPair[], events: WorldEvent[]): void {
    const tagger = world.players.find((p) => p.isTagger && p.alive);
    if (!tagger) return;

    for (const pair of pairs) {
        const otherId = pair.a === tagger.playerId ? pair.b : pair.b === tagger.playerId ? pair.a : null;
        if (otherId === null) continue;

        const victim = world.players.find((p) => p.playerId === otherId);
        if (!victim || !victim.alive) continue;

        victim.alive = false;
        victim.stats.taggedCount += 1;
        victim.stats.eliminatedAtTick = world.tick;
        tagger.stats.tagCount += 1;
        world.taggerChangedAtTick = world.tick;
        extendFrenzyOnTag(world, tagger);
        events.push({ kind: 'eliminated', playerId: victim.playerId, by: tagger.playerId });
    }
}

/**
 * 술래가 오래 안 바뀌면 강제로 바꾼다. 술래가 아무도 못 잡고 경기가 정체되는 것을 막는다.
 *
 * 대상 선택에 world의 PRNG를 쓴다. `Math.random()`을 쓰면 리플레이가 재현되지 않는다.
 */
function rotateTaggerIfStale(world: World, events: WorldEvent[]): void {
    const cooldownTicks = Math.round((GAMEPLAY.TAGGER_CHANGE_COOLDOWN_MS / 1000) * world.simulationHz);
    if (world.tick - world.taggerChangedAtTick < cooldownTicks) return;

    const runners = rotationCandidates(world);
    if (runners.length === 0) return;

    const picked = runners[world.nextRandomInt(runners.length)]!;
    for (const p of world.players) p.isTagger = p.playerId === picked.playerId;
    world.taggerChangedAtTick = world.tick;
    // 술래가 된 직후에는 광란이 붙는다. 강제 교체도 스위치 지목도 같은 취급이다.
    grantTaggerFrenzy(world, picked);
    events.push({ kind: 'tagged', playerId: picked.playerId });
}

/**
 * 쿨타임 회복 배수.
 *
 * 술래에게 붙어 있는 **러너**만 빨라진다. 위험한 자리에 있을수록 스킬을 자주 쓸 수 있게 해서
 * 도망만 다니는 것이 최선이 되지 않게 한다. 술래 자신은 거리 0이므로 명시적으로 제외한다 —
 * 안 그러면 예전의 "술래 쿨타임 2배"가 이름만 바꿔 돌아온다.
 */
function cooldownRate(player: PlayerState, tagger: PlayerState | null): number {
    if (player.isTagger || tagger === null || !player.alive) return 1;
    const dx = tagger.x - player.x;
    const dy = tagger.y - player.y;
    const radius = SKILLS.NEAR_TAGGER_RADIUS_PX;
    if (dx * dx + dy * dy > radius * radius) return 1;
    return 1 + SKILLS.NEAR_TAGGER_COOLDOWN_BONUS;
}

function survivors(world: World): PlayerState[] {
    return world.players.filter((p) => p.alive);
}

/** 종료 조건을 만족했는가. 등수는 없고 최후까지 남은 인원이 공동 승리자다. */
export function isFinished(world: World): boolean {
    return survivors(world).length <= GAMEPLAY.SURVIVORS_TO_WIN;
}

export function stepWorld(
    world: World,
    inputs: readonly ResolvedInput[],
    skillRequests: readonly SkillRequest[] = [],
    emojiRequests: readonly EmojiRequest[] = [],
): AuthoritativeFrame {
    const events: WorldEvent[] = [];
    const skillRejections: AuthoritativeFrame['skillRejections'] = [];
    world.tick += 1;
    world.tileChanges = [];

    // 1. 효과 만료와 쿨타임 회복. 이동 계산 전에 처리해야 이번 tick 속도에 반영된다.
    const tagger = world.players.find((p) => p.isTagger && p.alive) ?? null;
    for (const player of world.players) {
        expireEffects(world, player);
        tickCooldowns(player, cooldownRate(player, tagger));
        if (player.emoji !== null && player.emoji.expiresAtTick <= world.tick) player.emoji = null;
    }

    // 스킬은 이동보다 먼저 판정한다. 유체화를 쓴 tick부터 빨라져야 눌렀을 때 즉시 반응한다.
    // 요청 순서는 playerId로 고정한다. 같은 tick에 두 명이 스위치를 쓰면 순서가 결과를 바꾼다.
    for (const request of [...skillRequests].sort((a, b) => a.playerId - b.playerId)) {
        const outcome = useSkill(world, request, events);
        if (!outcome.ok) {
            skillRejections.push({ playerId: request.playerId, slot: request.slot, reason: outcome.reason });
        }
    }

    for (const request of [...emojiRequests].sort((a, b) => a.playerId - b.playerId)) {
        const player = world.players.find((candidate) => candidate.playerId === request.playerId);
        if (!player?.alive) continue;
        player.emoji = {
            emojiId: request.emojiId,
            expiresAtTick: world.tick + msToTicks(EMOJI_DISPLAY_MS, world.simulationHz),
        };
    }

    // 2. 맵 timeline의 현재 tick 변경 적용
    applyMapTimeline(world);

    // 3. 자기장 계산. inset = tick * barrierSpeed로 O(1)이다.
    const storm = stormRect(world);
    world.storm = storm;

    const inputById = new Map(inputs.map((i) => [i.playerId, i]));
    const ordered = [...world.players].sort((a, b) => a.playerId - b.playerId);

    // 4~6. 목표 속도 → 후보 위치 → 벽·자기장 충돌
    for (const player of ordered) {
        if (!player.alive) continue;

        const input = inputById.get(player.playerId);
        const target = input
            ? integrate(player, input)
            : // 입력이 없으면 정지시킨다. 연결이 끊긴 플레이어가 마지막 방향으로 계속 가면 안 된다.
              ((player.vx = 0), (player.vy = 0), { x: player.x, y: player.y });

        // 대시처럼 한 tick 이동량이 큰 경우 조각내서 민다. 안 그러면 얇은 벽을 통과한다.
        const steps = substepCount(player.x, player.y, target.x, target.y);
        const stepX = (target.x - player.x) / steps;
        const stepY = (target.y - player.y) / steps;

        for (let s = 0; s < steps; s++) {
            const resolved = resolveStatic(world.map, player.x + stepX, player.y + stepY, player.radius, storm);
            player.x = resolved.x;
            player.y = resolved.y;
        }
    }

    // 7~8. 플레이어 간 충돌과 정적 충돌을 번갈아 반복한다.
    //
    // 한 번만 돌리면 A를 B 밖으로 민 결과가 벽 안쪽일 수 있다. 벽으로 되밀면 다시 B와 겹친다.
    // 몇 번 반복하면 대부분 수렴한다. 접촉 쌍은 첫 반복의 것을 쓴다 — 뒤 반복은 이미 떼어낸
    // 상태라 접촉이 사라져 있고, 그걸로 판정하면 술래가 아무도 못 잡는다.
    let contactPairs: CollisionPair[] = [];
    for (let iteration = 0; iteration < GAMEPLAY.PLAYER_COLLISION_ITERATIONS; iteration++) {
        const pairs = resolvePlayerCollisions(ordered);
        if (iteration === 0) contactPairs = pairs;

        for (const player of ordered) {
            if (!player.alive) continue;
            const resolved = resolveStatic(world.map, player.x, player.y, player.radius, storm);
            player.x = resolved.x;
            player.y = resolved.y;
        }

        if (pairs.length === 0) break;
    }

    // 9~10. 술래 접촉, 생존 상태, 종료 조건
    resolveTagging(world, contactPairs, events);
    if (!isFinished(world)) rotateTaggerIfStale(world, events);

    // 11. 권위 프레임 확정. 여기까지가 연결을 모르는 단일 상태다.
    //     12단계 이후(시야 계산, 연결별 스냅샷)는 이 프레임에서 파생된다.
    return { tick: world.tick, world, events, skillRejections };
}
