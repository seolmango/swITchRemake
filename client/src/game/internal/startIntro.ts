/**
 * 경기 시작 연출의 시간표(BASE.md §2.8, §12.2). Phaser를 모르는 순수 함수라 따로 테스트한다.
 *
 * 카운트다운이 끝나는 시각(`endsAt`)에서 **거꾸로** 잰다. 그래서 맵을 늦게 받았거나 카운트다운
 * 도중에 다시 들어온 사람은 앞부분이 저절로 잘린다 — 연출을 끝까지 보여 주려고 시작을 늦추면
 * 그 사람만 늦게 출발하게 된다.
 *
 *   ... 전체 맵 ... | 내 자리로 다가감(TRAVEL_MS) | 도착해서 3·2·1(HOLD_MS) | 시작
 *
 * 마지막은 경기 배율로 잠깐 멈춘다. 연출이 끝나는 배율·중심이 실제 경기와 같아야 출발하는 순간
 * 위치를 다시 잃지 않는다(codex·Gemini 검토가 같은 지점을 짚었다). 카운트다운은 서버가 정하고
 * (`COUNTDOWN_MS`), 그 앞부분은 화면 준비에 쓰이며 남는 만큼이 전체 맵 구간이 된다.
 */
export const START_INTRO = {
    /** 내 자리에 도착한 뒤 경기 배율로 멈춰 3·2·1을 세는 시간. 숫자는 이 구간에만 뜬다. */
    HOLD_MS: 3000,
    /** 전체 맵에서 내 자리로 천천히 다가가는 시간. */
    TRAVEL_MS: 2200,
    /** 모션 줄이기: 움직이지 않고 3·2·1이 시작될 때 전체 맵에서 내 자리로 끊어 넘어간다. */
    REDUCED_CUT_MS: 3000,
    /** 남은 시간이 이보다 짧으면 연출을 시작하지 않는다. 한 번 깜빡이고 끝나는 연출은 방해다. */
    MIN_REMAINING_MS: 400,
    /** 시작한 뒤 "나" 표식이 사라지는 시간. 다른 사람 표식은 시작하는 순간 지운다. */
    SELF_FADE_MS: 500,
    /** 전체 맵을 비출 때 맵 둘레에 남기는 여백(화면 픽셀). */
    OVERVIEW_PADDING_PX: 48,
} as const;

/** 0이면 전체 맵, 1이면 내 자리(경기 배율). 그 사이는 다가가는 중이다. */
export function startIntroProgress(nowMs: number, endsAtMs: number, reducedMotion: boolean): number {
    const remaining = endsAtMs - nowMs;
    if (reducedMotion) return remaining <= START_INTRO.REDUCED_CUT_MS ? 1 : 0;
    if (remaining <= START_INTRO.HOLD_MS) return 1;
    const travelLeft = remaining - START_INTRO.HOLD_MS;
    if (travelLeft >= START_INTRO.TRAVEL_MS) return 0;
    return easeInOutSine(1 - travelLeft / START_INTRO.TRAVEL_MS);
}

/** 출발과 도착이 부드럽고 가운데도 급하지 않다. 천천히 다가가는 느낌에 맞춘다. */
function easeInOutSine(t: number): number {
    return -(Math.cos(Math.PI * t) - 1) / 2;
}

export interface IntroCameraEnd {
    x: number;
    y: number;
    zoom: number;
}

/**
 * 전체 맵 시점과 내 자리 시점 사이의 카메라. 줌은 로그 공간에서 섞는다 — 선형으로 섞으면 확대가
 * 끝에 몰려 "가만히 있다가 갑자기 꽂히는" 느낌이 난다.
 */
export function blendIntroCamera(from: IntroCameraEnd, to: IntroCameraEnd, progress: number): IntroCameraEnd {
    const t = Math.min(1, Math.max(0, progress));
    return {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        zoom: Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * t),
    };
}
