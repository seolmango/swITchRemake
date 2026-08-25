/**
 * 레벨과 경험치.
 *
 * **레벨은 저장하지 않는다.** 누적 XP의 함수이기 때문이다 — 두 군데 적어 두면 언젠가 어긋나고,
 * 곡선을 조정하는 순간 이미 저장된 레벨은 전부 거짓이 된다. DB에는 XP만 쌓고 레벨은 읽을 때 센다.
 *
 * 값은 여기 한 곳에만 있다. 밸런스를 만지는 사람이 SQL을 읽지 않아도 되게 하려는 것이다.
 */

export const PROGRESSION = Object.freeze({
    /** 끝까지 있기만 해도 받는 몫. 이기지 못한 판도 시간이 남아야 다시 들어온다. */
    XP_PER_MATCH: 40,
    /** 공동 우승 둘 다 받는다. */
    XP_PER_WIN: 60,
    /** 술래로서 한 명 아웃. */
    XP_PER_TAG: 20,
    /** 스위치 성공. 시도만 한 것은 세지 않는다 — 아무 데나 누르는 것이 이득이면 안 된다. */
    XP_PER_SWITCH_SUCCESS: 15,

    /** 1 -> 2레벨 비용. */
    LEVEL_BASE_COST: 100,
    /** 레벨이 하나 오를 때마다 다음 비용에 더해지는 값. 선형으로 늘어난다. */
    LEVEL_COST_STEP: 50,
});

export interface MatchXpInput {
    readonly won: boolean;
    readonly tagCount: number;
    readonly switchSuccess: number;
}

/** 한 경기에서 얻는 XP. 게스트에게는 부르지 않는다 — 쌓아 둘 계정이 없다. */
export function matchXp(input: MatchXpInput): number {
    return PROGRESSION.XP_PER_MATCH
        + (input.won ? PROGRESSION.XP_PER_WIN : 0)
        + Math.max(0, input.tagCount) * PROGRESSION.XP_PER_TAG
        + Math.max(0, input.switchSuccess) * PROGRESSION.XP_PER_SWITCH_SUCCESS;
}

export interface LevelProgress {
    /** 1부터 시작한다. 0레벨은 없다 — 가입하자마자 0이면 아직 아무것도 아닌 것처럼 보인다. */
    level: number;
    /** 이번 레벨에서 지금까지 모은 XP. */
    xpIntoLevel: number;
    /** 이번 레벨을 넘기는 데 필요한 총 XP. */
    xpForNextLevel: number;
}

/**
 * 누적 XP에서 레벨을 센다.
 *
 * 닫힌 식 대신 반복으로 세는 이유는 곡선을 바꿔도 이 함수만 고치면 되기 때문이다.
 * 비용이 선형으로 늘어나 레벨 수는 XP의 제곱근에 비례한다 — 억 단위 XP라도 수천 번이다.
 */
export function levelFromXp(xp: number): LevelProgress {
    let remaining = Number.isFinite(xp) && xp > 0 ? Math.floor(xp) : 0;
    let level = 1;
    let cost = PROGRESSION.LEVEL_BASE_COST;
    while (remaining >= cost) {
        remaining -= cost;
        level += 1;
        cost += PROGRESSION.LEVEL_COST_STEP;
    }
    return { level, xpIntoLevel: remaining, xpForNextLevel: cost };
}
