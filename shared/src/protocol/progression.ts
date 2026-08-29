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

    /**
     * 살아 있던 1분당. 초 단위로 비례해 준다 — 59초와 60초 사이에 절벽이 있으면
     * 마지막 1초를 버티려고 이상한 플레이를 한다.
     *
     * 승리(60)와 비슷한 무게로 잡았다. 다섯 판 중 이기는 건 한 판 뿐이지만 오래 버티는 건
     * 매 판 할 수 있는 일이라, 이 항목이 "졌지만 잘 싸운 판"의 보상 대부분을 담당한다.
     */
    XP_PER_SURVIVED_MINUTE: 12,
    /**
     * 생존 XP를 세는 시간의 상한.
     *
     * 경기 길이는 자기장 타임라인이 정하지만 맵마다 다르고, 훈련장처럼 자기장이 멈춘 방도 있다.
     * 상한이 없으면 "안 끝나는 방에서 가만히 서 있기"가 최고 효율이 된다.
     */
    XP_SURVIVAL_CAP_MS: 10 * 60 * 1_000,

    /** 1 -> 2레벨 비용. */
    LEVEL_BASE_COST: 100,
    /** 레벨이 하나 오를 때마다 다음 비용에 더해지는 값. 선형으로 늘어난다. */
    LEVEL_COST_STEP: 50,
});

export interface MatchXpInput {
    readonly won: boolean;
    readonly tagCount: number;
    readonly switchSuccess: number;
    /**
     * 살아 있던 시간. 경기 전체를 살아남았으면 경기 길이와 같다.
     *
     * 빠뜨리면 0으로 본다 — 이 항목이 생기기 전에 쓰인 호출부가 조용히 남의 XP를 깎지 않게.
     */
    readonly survivedMs?: number;
}

/** XP를 어디서 얼마나 받았는지. 결과 화면이 이걸 그대로 줄 세운다. */
export interface MatchXpBreakdown {
    readonly played: number;
    readonly win: number;
    readonly tags: number;
    readonly switches: number;
    readonly survival: number;
    readonly total: number;
}

/**
 * 한 경기의 XP 내역. 게스트에게는 부르지 않는다 — 쌓아 둘 계정이 없다.
 *
 * 음수와 NaN을 여기서 막는다. 결과는 인게임 서버가 만들지만 스트림과 DB를 거쳐 오고,
 * 한 번이라도 통과하면 한 판으로 남의 XP를 되돌릴 수 있다.
 */
export function matchXpBreakdown(input: MatchXpInput): MatchXpBreakdown {
    const survivedMs = Math.min(
        PROGRESSION.XP_SURVIVAL_CAP_MS,
        Number.isFinite(input.survivedMs) ? Math.max(0, input.survivedMs!) : 0,
    );
    const played = PROGRESSION.XP_PER_MATCH;
    const win = input.won ? PROGRESSION.XP_PER_WIN : 0;
    const tags = Math.max(0, Math.floor(input.tagCount)) * PROGRESSION.XP_PER_TAG;
    const switches = Math.max(0, Math.floor(input.switchSuccess)) * PROGRESSION.XP_PER_SWITCH_SUCCESS;
    const survival = Math.floor(survivedMs / 60_000 * PROGRESSION.XP_PER_SURVIVED_MINUTE);
    return { played, win, tags, switches, survival, total: played + win + tags + switches + survival };
}

/** 합계만 필요한 곳(결과 적재)이 쓴다. */
export function matchXp(input: MatchXpInput): number {
    return matchXpBreakdown(input).total;
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
