import { MOVEMENT, SKILL_TUNING, SPEED_DECREASE_FLOOR, TILE_PX as SHARED_TILE_PX } from 'shared';
import { NETWORK } from './network';

/**
 * 밸런스 수치. 환경 변수가 아니라 버전 관리되는 타입 안전한 파일에 둔다.
 *
 * 이동 속도와 스킬 수치는 **레거시에서 역산한 값**이다. 레거시 클라이언트는 30Hz로 돌면서
 * milli-tile 단위로 이동량을 보냈고(레거시 `main.js:272-275`), 타일은 256px다.
 *
 *   58 milli-tile/tick × 30 tick/s = 1.74 tile/s × 256 px/tile ≈ 445 px/s
 *
 * 레거시의 속도감이 나쁘지 않다는 판단에 따라 그 값을 그대로 기준으로 삼았다. 밸런스 패치는
 * 나중에 쉬우므로 지금은 "검증된 감각"에서 출발하는 편이 임의의 숫자보다 낫다.
 *
 * 이 파일이 바뀌면 `RULES_VERSION`도 바뀌어야 한다. 진행 중인 방은 생성 시점의 snapshot을 쓰므로
 * 프로세스 재시작 없이 게임 중간에 전역 값이 바뀌는 일은 없다.
 */

/** 밸런스가 바뀌면 올린다. 경기 결과와 리플레이에 함께 기록되어 "그 경기가 어떤 규칙이었는지"를 남긴다. */
export const RULES_VERSION = '0.5.0-match-time-limit';

const TILE_PX = SHARED_TILE_PX;

/** How long an accepted emoji remains visible in authoritative snapshots. */
export const EMOJI_DISPLAY_MS = 3_000;

export const GAMEPLAY = Object.freeze({
    // ── 이동 ──
    PLAYER_RADIUS_PX: MOVEMENT.PLAYER_RADIUS_TILES * TILE_PX,
    BASE_MOVE_SPEED_PX_PER_SEC: MOVEMENT.BASE_SPEED_TILES_PER_SEC * TILE_PX,
    /** 한 tick 이동량이 이보다 크면 sub-step으로 쪼갠다. 대시가 벽을 통과하는 것을 막는다. */
    MAX_SUBSTEP_DISTANCE_PX: 48,

    // ── 플레이어 간 밀어내기 (레거시에는 없던 신규 규칙) ──
    /** 정지한 플레이어의 기본 저항. 둘 다 정지해 있으면 절반씩 밀린다. */
    PUSH_BASE_POWER: 1,
    /** 접근 속도가 밀어내는 힘에 기여하는 비율. */
    PUSH_SPEED_FACTOR: 0.01,
    /** 정적 충돌과 pair 충돌을 몇 번 반복할지. 벽에 낀 채로 상대를 벽 너머로 미는 것을 줄인다. */
    PLAYER_COLLISION_ITERATIONS: 4,

    // ── 시야 ──
    /**
     * 시야 사각형의 가로 폭(px). 세로는 16:9로 파생된다.
     * 레거시는 16타일이었다(`PlayerSightRanges = 160`, 10을 곱해 저장).
     */
    SIGHT_RANGE_PX: 16 * TILE_PX,

    // ── 술래 ──
    /** 레거시와 동일. 술래가 오래 안 바뀌면 경기가 정체된다. */
    TAGGER_CHANGE_COOLDOWN_MS: SKILL_TUNING.TAGGER_CHANGE_COOLDOWN_MS,

    // ── 방 ──
    MIN_PLAYERS_TO_START: 3,
    MAX_PLAYERS: 8,
    /** 최후 이 인원이 남으면 경기가 끝나고, 남은 전원이 공동 승리자다. 등수는 없다. */
    SURVIVORS_TO_WIN: 2,
    /**
     * 정상 경기는 약 5분 안팎이므로 20분은 밸런스에 간섭하지 않으면서도, 닫힌 자기장이나 잘못된
     * 맵 때문에 방이 영구히 남는 것을 막기에 충분히 넉넉한 안전망이다. 벽시계가 아니라 권위
     * simulation tick으로 비교해 서버 부하와 무관하게 같은 입력이 같은 tick에 끝나게 한다.
     */
    MAX_MATCH_DURATION_TICKS: 20 * 60 * NETWORK.SIMULATION_HZ,
});

/**
 * 속도 계산식과 효과 중첩 규칙.
 *
 *   speed = BASE × (1 + Σincrease) × max(FLOOR, 1 − Σdecrease)
 *
 * 증가군과 감소군이 각각 더해지고 두 군이 곱해진다. 하나의 덧셈 풀로 합치면 유체화 + 탈진이
 * 정확히 상쇄되어 기본 속도가 되는데, 그러면 탈진이 유체화를 "해제"하는 것처럼 보인다.
 * 군을 곱하면 둘 다 걸렸을 때 기본보다 느리되 완전 상쇄는 아닌 상태가 된다.
 */
export const SPEED = Object.freeze({
    DECREASE_FLOOR: SPEED_DECREASE_FLOOR,
});

/**
 * 스킬.
 *
 * 슬롯은 정확히 2개다. 1번은 switch(러너 전용, 자동 지급), 2번은 경기 전에 고른 dash·flash·exhaust
 * 중 하나. 술래가 되면 switch 슬롯이 비활성이라 사실상 고른 스킬 하나만 남는다.
 *
 * 쿨타임은 **술래일 때 두 배로 빨리 찬다.** 레거시가 매 tick 2씩 깎았다
 * (레거시 `main.js:275`). 쫓는 쪽이 더 자주 쓸 수 있어야 추격이 성립한다.
 */
export const SKILLS = Object.freeze({
    /**
     * 술래 근처에 있는 **러너**의 쿨타임 회복 보너스. 위험한 자리에 있을수록 스킬을 자주 쓴다.
     * 예전에는 반대로 술래 쪽을 2배로 돌렸는데, 그러면 도망치는 쪽이 위험을 무릅쓸 이유가 없었다.
     */
    NEAR_TAGGER_COOLDOWN_BONUS: SKILL_TUNING.NEAR_TAGGER_COOLDOWN_BONUS,
    NEAR_TAGGER_RADIUS_PX: SKILL_TUNING.NEAR_TAGGER_RADIUS_TILES * TILE_PX,

    /**
     * 유체화. 레거시의 `Boost`가 이 스킬이다 — 이름은 점멸이었지만 실제 동작은 속도 버프였다.
     * 레거시는 1초 3배였는데, 지금은 5초 1.5배다. 순간 폭발보다 "계속 빠른 상태"가 이 스킬의
     * 성격에 맞고, 점멸보다 멀리 간다는 조건도 그래야 성립한다(tuning.ts의 표 참고).
     */
    DASH: {
        SPEED_INCREASE: SKILL_TUNING.DASH_SPEED_INCREASE,
        DURATION_MS: SKILL_TUNING.DASH_DURATION_MS,
        COOLDOWN_MS: SKILL_TUNING.DASH_COOLDOWN_MS,
    },

    /**
     * 점멸. 레거시에는 없던 신규 스킬이라 기준 삼을 값이 없다.
     *
     * **벽을 넘는다.** 이게 없으면 유체화와 밸런스가 맞지 않는다. 유체화가 5초 동안 4.35타일을
     * 더 벌기 때문에, 점멸의 값어치는 거리가 아니라 "벽 너머로 즉시" 간다는 데 있어야 한다.
     * 대신 쿨타임이 셋 중 가장 짧다.
     *
     * 착지점이 벽 속이면 진행 방향으로 밀어 바깥으로 내보낸다. 뒤로 되돌리면 "썼는데 제자리"가
     * 되어 불쾌하다. 애매한 상황은 쓴 사람에게 유리하게 푼다.
     */
    FLASH: {
        DISTANCE_PX: SKILL_TUNING.FLASH_DISTANCE_TILES * TILE_PX,
        /** 벽 속에 착지했을 때 진행 방향으로 더 밀어볼 수 있는 최대 거리. 두꺼운 벽도 넘을 만큼. */
        WALL_EXIT_MAX_PX: 2 * TILE_PX,
        COOLDOWN_MS: SKILL_TUNING.FLASH_COOLDOWN_MS,
    },

    /**
     * 탈진. 사거리 안의 **모두**를 느리게 만든다. 광역기라 쿨타임이 셋 중 가장 길고,
     * **시전자도 함께 느려진다.** 대가가 없으면 붙어서 누르는 것이 언제나 이득이라 판단이 사라진다.
     *
     * 진영 판정을 하지 않는다. 러너가 다른 러너를 탈진시킬 수 있다. 이 게임은 팀 게임이 아니라
     * 개인전이며, 곰이 달려올 때 옆사람보다만 빠르면 되기 때문이다. 의도된 설계다.
     */
    EXHAUST: {
        SPEED_DECREASE: SKILL_TUNING.EXHAUST_SPEED_DECREASE,
        DURATION_MS: SKILL_TUNING.EXHAUST_DURATION_MS,
        RANGE_PX: SKILL_TUNING.EXHAUST_RANGE_TILES * TILE_PX,
        COOLDOWN_MS: SKILL_TUNING.EXHAUST_COOLDOWN_MS,
        SELF_DECREASE: SKILL_TUNING.EXHAUST_SELF_DECREASE,
        SELF_DURATION_MS: SKILL_TUNING.EXHAUST_SELF_DURATION_MS,
    },

    /**
     * 스위치. 이 게임의 이름이 여기서 왔다. 러너 전용.
     *
     * 현재 술래에게 사거리 안으로 붙은 상태에서 발동하고, **살아 있는 다른 러너 아무나**를 지목해
     * 새 술래로 만든다. 지목 대상까지의 거리는 상관없다 — 맵 반대편의 방심하던 사람이 갑자기
     * 술래가 되는 순간이 이 스킬의 전부다.
     *
     * 시전자는 러너로 남는다. 기존 술래는 러너로 강등된다.
     * 사거리 밖에서 쓴 실패도 쿨타임을 소모한다. 아무 때나 눌러보는 것을 막는다.
     *
     * 사거리는 레거시 `CheckTouch(..., (TaggerChaRad + CharRad) * 1000)`에서 왔다. 1.0 + 0.4 타일.
     */
    SWITCH: {
        RANGE_PX: SKILL_TUNING.SWITCH_RANGE_TILES * TILE_PX,
        COOLDOWN_MS: SKILL_TUNING.SWITCH_COOLDOWN_MS,
    },

    /**
     * 광란. 스킬이 아니라 자동으로 붙는 효과다.
     * 술래가 된 직후(경기 시작·강제 교체·스위치 지목)와, 스위치를 성공시킨 시전자에게 붙는다.
     * 시전자는 러너로 남지만 도망칠 시간을 벌어야 하기 때문이다.
     */
    FRENZY: {
        SPEED_INCREASE: SKILL_TUNING.FRENZY_SPEED_INCREASE,
        DURATION_MS: SKILL_TUNING.FRENZY_DURATION_MS,
        /** 광란 중에 아웃시키면 붙는 추가분. 잘 잡는 술래가 점점 빨라진다. */
        TAG_BONUS_INCREASE: SKILL_TUNING.FRENZY_TAG_BONUS_INCREASE,
        TAG_BONUS_MS: SKILL_TUNING.FRENZY_TAG_BONUS_MS,
    },

    /**
     * 스위치로 강등된 기존 술래에게 붙는 감속.
     *
     * 별도 효과 타입을 만들지 않고 탈진과 같은 타입을 쓴다. 클라이언트가 받는 것은 "느려졌다"와
     * 남은 시간 비율뿐이고 크기는 서버만 안다. 표시가 같아야 하는 두 상태에 wire 필드를 하나 더
     * 늘릴 이유가 없다.
     */
    SWITCH_VICTIM: {
        SPEED_DECREASE: SKILL_TUNING.SWITCH_VICTIM_SPEED_DECREASE,
        DURATION_MS: SKILL_TUNING.SWITCH_VICTIM_DURATION_MS,
    },
});

/**
 * 클라이언트 HUD가 필요로 하는 값. `game.starting` 메시지에 실려 나간다.
 * 클라이언트에 같은 상수를 복사하지 않기 위한 통로이므로, HUD가 쓰는 값은 반드시 여기를 지나야 한다.
 */
export function hudGameplayPayload(): Record<string, number> {
    return {
        simulationHz: NETWORK.SIMULATION_HZ,
        taggerChangeCooldownMs: GAMEPLAY.TAGGER_CHANGE_COOLDOWN_MS,
        playerRadiusPx: GAMEPLAY.PLAYER_RADIUS_PX,
        dashDurationMs: SKILLS.DASH.DURATION_MS,
        dashCooldownMs: SKILLS.DASH.COOLDOWN_MS,
        flashCooldownMs: SKILLS.FLASH.COOLDOWN_MS,
        flashDistancePx: SKILLS.FLASH.DISTANCE_PX,
        exhaustDurationMs: SKILLS.EXHAUST.DURATION_MS,
        exhaustCooldownMs: SKILLS.EXHAUST.COOLDOWN_MS,
        exhaustRangePx: SKILLS.EXHAUST.RANGE_PX,
        switchCooldownMs: SKILLS.SWITCH.COOLDOWN_MS,
        switchRangePx: SKILLS.SWITCH.RANGE_PX,
        frenzyDurationMs: SKILLS.FRENZY.DURATION_MS,
        nearTaggerCooldownBonus: SKILLS.NEAR_TAGGER_COOLDOWN_BONUS,
        nearTaggerRadiusPx: SKILLS.NEAR_TAGGER_RADIUS_PX,
    };
}

export type GameplayConfig = typeof GAMEPLAY;
