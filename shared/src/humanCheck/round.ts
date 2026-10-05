/**
 * 공개 층: "라스트 세컨드 스위치".
 *
 * 술래가 나에게 달려온다. 술래가 접근 반경에 들어온 순간부터 잡히기 직전까지, 내 스위치 사거리
 * 안에 들어와 있는 도망자 번호를 누르면 술래가 그 사람에게 넘어간다 — 게임의 핵심 장면 그대로다.
 * 더 일찍 누르면 술래가 아직 멀고, 사거리 안에 잠깐 들렀다 나가는 미끼도 있다.
 *
 * 장면 전체가 시드 하나에서 나온다. 서버는 시드를 다시 풀어 정답 번호와 시간 창만 확인하고,
 * 클라이언트는 같은 시드로 궤적을 그린다. 좌표 계산(삼각함수)은 그리기에만 쓰고 판정은 정수
 * 시각과 번호만 쓰므로 엔진마다 다른 부동소수 오차가 판정에 끼지 않는다.
 *
 * 한계를 숨기지 않는다: 이 파일을 그대로 가져가 쓰는 전용 봇은 풀 수 있다. 이 층이 하는 일은
 * 범용 봇·풀이 대행을 막고 시도 하나에 실제 시간(약 2~3초)과 작업 증명을 붙이는 것이다.
 * 대량 공격의 비용은 작업 증명, 실패 누적 난이도, 발급 한도가 함께 만든다.
 */

export const HUMAN_ROUND_VERSION = 1;

/** 아레나 좌표계. 화면 비율(16:10)에 맞춘 임의 단위다. */
export const SWITCH_ROUND = {
    width: 160,
    height: 100,
    self: { x: 80, y: 56 },
    /** 스위치 사거리. 이 원 안의 도망자만 대상이 된다. */
    range: 22,
    /** 술래가 이 안으로 들어오면 스위치를 쓸 수 있다. */
    approach: 34,
    /** 판정 여유. 화면 갱신·입력 지연을 덮는다. */
    graceMs: 150,
} as const;

export interface RoundKey {
    /** 라운드 시작 기준 ms. */
    t: number;
    /** 나로부터의 거리(아레나 단위). */
    r: number;
    /** 화면 좌표 기준 각도(도). 0 = 오른쪽, 90 = 아래, 270 = 위. */
    a: number;
}

export interface RoundActor {
    slot: number;
    keys: readonly RoundKey[];
}

export interface SwitchRound {
    version: number;
    selfSlot: number;
    tagger: RoundActor;
    runners: readonly RoundActor[];
    /** 술래가 접근 반경에 들어오는 시각. 이때부터 스위치를 쓸 수 있다. */
    openAt: number;
    /** 술래에게 잡히는 시각. 여기까지 넘기지 못하면 실패다. */
    caughtAt: number;
    /** 라운드가 끝나는 시각. */
    endAt: number;
    /** 시간 창 동안 사거리 안에 있는 유일한 도망자. */
    target: number;
}

/** 32비트 시드 PRNG(mulberry32). 정수 연산만 쓰므로 어느 엔진에서도 같은 수열이 나온다. */
export function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
    };
}

const intBetween = (random: () => number, min: number, max: number): number =>
    min + Math.floor(random() * (max - min + 1));

export function shuffledSlots(random: () => number): number[] {
    const slots = [1, 2, 3, 4, 5, 6, 7, 8];
    for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [slots[i], slots[j]] = [slots[j]!, slots[i]!];
    }
    return slots;
}

const angleGap = (a: number, b: number): number => {
    const diff = Math.abs(a - b) % 360;
    return diff > 180 ? 360 - diff : diff;
};

export function buildSwitchRound(seed: number): SwitchRound {
    const random = seededRandom(seed);
    const slots = shuffledSlots(random);
    const selfSlot = slots[0]!;
    const taggerSlot = slots[1]!;
    const runnerCount = random() < 0.5 ? 4 : 5;
    const runnerSlots = slots.slice(2, 2 + runnerCount);

    const openAt = intBetween(random, 1_900, 2_600);
    const caughtAt = openAt + intBetween(random, 1_000, 1_300);
    const endAt = caughtAt + 500;

    // 술래는 왼쪽·오른쪽·위에서만 온다. 아래쪽은 손가락이 가리는 자리다.
    const taggerAngle = [180, 0, 270][intBetween(random, 0, 2)]!;
    const tagger: RoundActor = {
        slot: taggerSlot,
        keys: [
            { t: 0, r: 64, a: taggerAngle },
            { t: openAt, r: SWITCH_ROUND.approach, a: taggerAngle },
            { t: caughtAt, r: 8, a: taggerAngle },
            { t: endAt, r: 8, a: taggerAngle },
        ],
    };

    // 30° 간격 열두 방향 중 술래 쪽 ±45°를 뺀 자리에 도망자를 흩는다. 서로 겹치지 않게 한 칸씩 띄운다.
    const free = Array.from({ length: 12 }, (_, i) => i * 30).filter((a) => angleGap(a, taggerAngle) > 45);
    for (let i = free.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [free[i], free[j]] = [free[j]!, free[i]!];
    }
    const angles: number[] = [];
    for (const candidate of free) {
        if (angles.every((taken) => angleGap(taken, candidate) >= 60)) angles.push(candidate);
        if (angles.length === runnerCount) break;
    }
    // 60° 간격으로 다 못 채우면 30° 간격으로 채운다(5명일 때 생길 수 있다).
    for (const candidate of free) {
        if (angles.length === runnerCount) break;
        if (!angles.includes(candidate)) angles.push(candidate);
    }

    const drift = () => intBetween(random, -12, 12);
    const runners: RoundActor[] = runnerSlots.map((slot, index) => {
        const a = angles[index]!;
        if (index === 0) {
            // 정답: 술래가 오기 조금 전에 사거리로 들어와 잡히는 순간까지 머문다.
            const enter = openAt - intBetween(random, 300, 700);
            return { slot, keys: [
                { t: 0, r: 40, a },
                { t: enter, r: 15, a: a + drift() },
                { t: caughtAt + 300, r: 17, a: a + drift() },
                { t: endAt, r: 30, a: a + drift() },
            ] };
        }
        if (index === 1 || (index === 2 && runnerCount === 5)) {
            // 미끼: 일찍 사거리에 들렀다가 술래가 오기 전에 빠져나간다. 서두르면 이 번호를 누르게 된다.
            const inAt = intBetween(random, 400, 800);
            const outAt = openAt - intBetween(random, 350, 550);
            return { slot, keys: [
                { t: 0, r: 38, a },
                { t: inAt, r: 14, a: a + drift() },
                { t: outAt, r: 34, a: a + drift() },
                { t: endAt, r: intBetween(random, 34, 40), a: a + drift() },
            ] };
        }
        // 나머지: 사거리 밖에서 서성인다.
        return { slot, keys: [
            { t: 0, r: intBetween(random, 34, 42), a },
            { t: Math.floor(endAt / 2), r: intBetween(random, 32, 42), a: a + drift() },
            { t: endAt, r: intBetween(random, 34, 42), a: a + drift() },
        ] };
    });

    // 화면에 그리는 순서가 정답을 흘리지 않게 번호 순으로 정렬한다.
    const target = runners[0]!.slot;
    runners.sort((left, right) => left.slot - right.slot);
    return { version: HUMAN_ROUND_VERSION, selfSlot, tagger, runners, openAt, caughtAt, endAt, target };
}

/** 키프레임 사이를 선형 보간한 위치. 그리기 전용이다 — 판정은 이 값을 쓰지 않는다. */
export function roundPosition(keys: readonly RoundKey[], t: number): { x: number; y: number; r: number } {
    let prev = keys[0]!;
    let next = keys[keys.length - 1]!;
    for (let i = 1; i < keys.length; i++) {
        if (keys[i]!.t >= t) { prev = keys[i - 1]!; next = keys[i]!; break; }
    }
    const span = next.t - prev.t;
    const k = span <= 0 ? 1 : Math.min(1, Math.max(0, (t - prev.t) / span));
    const r = prev.r + (next.r - prev.r) * k;
    const a = (prev.a + (next.a - prev.a) * k) * Math.PI / 180;
    return { x: SWITCH_ROUND.self.x + Math.cos(a) * r, y: SWITCH_ROUND.self.y + Math.sin(a) * r, r };
}

export function checkSwitchAnswer(round: SwitchRound, slot: number, atMs: number): 'ok' | 'early' | 'late' | 'wrong' {
    if (atMs < round.openAt - SWITCH_ROUND.graceMs) return 'early';
    if (atMs > round.caughtAt + SWITCH_ROUND.graceMs) return 'late';
    return slot === round.target ? 'ok' : 'wrong';
}

/**
 * 접근성 경로: "관전석 무전". 같은 상황을 턴제 중계로 들려준다. 화면을 못 보거나, 빠르게 누를
 * 수 없거나, 움직임을 줄여 둔 사람을 위한 길이다. 시간 압박이 없는 대신 서버가 작업 증명을
 * 더 무겁게 걸고 최소 소요 시간을 둔다 — 봇에게 더 싼 뒷문이 되면 안 된다.
 */
export const RADIO_ROUND = {
    /** 스위치 사거리(칸). */
    range: 2,
    /** 이보다 빨리 답하면 받지 않는다. 중계를 끝까지 들을 시간이다. */
    minElapsedMs: 6_000,
} as const;

export interface RadioTurn {
    /** 술래와 나 사이 거리(칸). */
    tagger: number;
    /** 이 턴에 거리가 바뀐 도망자. 첫 턴은 전원의 거리. */
    moves: readonly { slot: number; distance: number }[];
}

export interface RadioRound {
    version: number;
    selfSlot: number;
    taggerSlot: number;
    runnerSlots: readonly number[];
    turns: readonly RadioTurn[];
    target: number;
}

export function buildRadioRound(seed: number): RadioRound {
    const random = seededRandom(seed);
    const slots = shuffledSlots(random);
    const selfSlot = slots[0]!;
    const taggerSlot = slots[1]!;
    const [target, bait, walker, idle] = slots.slice(2, 6) as [number, number, number, number];

    // 처음에는 미끼만 사거리 안에 있다. 끝에는 정답만 사거리 안에 있다.
    const targetStart = intBetween(random, 4, 6);
    const targetMid = intBetween(random, 3, targetStart - 1);
    const targetEnd = intBetween(random, 1, RADIO_ROUND.range);
    const baitStart = intBetween(random, 1, RADIO_ROUND.range);
    const baitMid = intBetween(random, 4, 6);
    const walkerStart = intBetween(random, 5, 7);
    const walkerEnd = intBetween(random, 4, walkerStart - 1);
    const idleAt = intBetween(random, 4, 7);

    const firstMoves = [
        { slot: target, distance: targetStart },
        { slot: bait, distance: baitStart },
        { slot: walker, distance: walkerStart },
        { slot: idle, distance: idleAt },
    ].sort((left, right) => left.slot - right.slot);
    const turns: RadioTurn[] = [
        { tagger: 6, moves: firstMoves },
        { tagger: 4, moves: [{ slot: target, distance: targetMid }, { slot: bait, distance: baitMid }].sort((l, r) => l.slot - r.slot) },
        { tagger: 2, moves: [{ slot: target, distance: targetEnd }, { slot: walker, distance: walkerEnd }].sort((l, r) => l.slot - r.slot) },
    ];
    return {
        version: HUMAN_ROUND_VERSION,
        selfSlot,
        taggerSlot,
        runnerSlots: [target, bait, walker, idle].sort((l, r) => l - r),
        turns,
        target,
    };
}
