import {
    EffectType,
    MOVEMENT,
    PROTOCOL_VERSION,
    SKILL_TUNING,
    TILE_PX,
    TilePhysics,
    encodeSnapshot,
    type Snapshot,
    type SnapshotPlayer,
} from 'shared';

export const HELP_DEMO_HZ = 30;
export const HELP_DEMO_FRAME_MS = 1_000 / HELP_DEMO_HZ;
const FRAME_COUNT = 150;

/**
 * 이 게임에 실제로 있는 스킬은 넷이다(`shared`의 `SkillId`). 여기에 없는 것을 넣으면
 * 도움말이 존재하지 않는 조작을 가르친다.
 *
 * 술래 외형은 스킬이 아니라 별도 화면이라 이 목록에 없다.
 */
export const HELP_DEMO_IDS = ['dash', 'flash', 'exhaust', 'switch'] as const;
export type HelpDemoId = (typeof HELP_DEMO_IDS)[number];

/** 술래 외형 데모. 스킬 탭과 섞이면 "술래도 스킬"로 읽힌다. */
export const TAGGER_DEMO_ID = 'tagger';
export type DemoId = HelpDemoId | typeof TAGGER_DEMO_ID;
const ALL_DEMO_IDS = [TAGGER_DEMO_ID, ...HELP_DEMO_IDS] as const;

interface DemoEvent {
    blink?: { playerId: number; fromX: number; fromY: number };
    /** 사거리 원. 인게임과 같은 경로(`playSkillArea`)를 탄다. */
    skillArea?: { playerId: number; x: number; y: number; affectedPlayerId: number | null; rangePx: number };
}

export interface EncodedDemoFrame {
    buffer: ArrayBuffer;
    event?: DemoEvent;
}

export interface HelpDemoTimeline {
    frames: readonly EncodedDemoFrame[];
    poster: ArrayBuffer;
    /** 카메라가 맞출 세계 좌표 사각형. 맵 전체가 아니라 이 부분만 보여 준다. */
    view: { x: number; y: number; width: number; height: number };
}

/**
 * 데모는 **실제 밸런스 수치로 움직인다.** 손으로 찍은 키프레임을 쓰면 속도를 조정할 때마다
 * 도움말이 조용히 거짓말이 된다. 값은 `shared`의 `MOVEMENT`/`SKILL_TUNING`에 한 벌만 있고
 * 서버도 같은 파일에서 가져다 쓴다.
 */
const perFrame = (tilesPerSecond: number): number => tilesPerSecond * TILE_PX / HELP_DEMO_HZ;
const framesFor = (ms: number): number => Math.round(ms / HELP_DEMO_FRAME_MS);

const BASE_STEP = perFrame(MOVEMENT.BASE_SPEED_TILES_PER_SEC);
const DASH_STEP = perFrame(MOVEMENT.BASE_SPEED_TILES_PER_SEC * (1 + SKILL_TUNING.DASH_SPEED_INCREASE));
const EXHAUST_STEP = perFrame(MOVEMENT.BASE_SPEED_TILES_PER_SEC * (1 - SKILL_TUNING.EXHAUST_SPEED_DECREASE));
const FRENZY_STEP = perFrame(MOVEMENT.BASE_SPEED_TILES_PER_SEC * (1 + SKILL_TUNING.FRENZY_SPEED_INCREASE));

const DASH_FRAMES = framesFor(SKILL_TUNING.DASH_DURATION_MS);
const EXHAUST_FRAMES = framesFor(SKILL_TUNING.EXHAUST_DURATION_MS);
const FRENZY_FRAMES = framesFor(SKILL_TUNING.FRENZY_DURATION_MS);

/** 몸이 겹치지 않는 최소 중심 거리. 겹친 채로 지나가면 밀어내기 규칙이 없는 것처럼 보인다. */
const BODY_GAP = MOVEMENT.PLAYER_RADIUS_TILES * 2 * TILE_PX;

/**
 * 데모 맵은 화면에 보이는 것보다 넉넉히 크다. 맵 전체를 화면에 맞추면 사방이 자기장 테두리로
 * 둘러싸여 실제 경기와 전혀 다르게 보인다 — 경기 중에는 늘 맵의 일부만 보인다.
 *
 * 벽은 데모의 이동 경로를 피해 배치했다. 점멸만 예외로 6열의 벽을 가로지른다.
 */
const W = TilePhysics.Wall;
const F = TilePhysics.Floor;
const MAP_TILES: TilePhysics[][] = [
    [W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W],
    [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
    [W, F, F, W, F, F, W, F, F, F, F, W, W, F, F, W],
    [W, F, F, F, F, F, W, F, F, F, F, F, F, F, F, W],
    [W, F, F, F, F, F, W, F, F, F, F, F, F, F, F, W],
    [W, F, F, F, F, F, F, F, F, W, F, F, F, F, F, W],
    [W, F, F, F, F, F, F, F, F, W, F, F, F, F, F, W],
    [W, F, F, F, F, F, F, F, F, F, F, F, F, F, F, W],
    [W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W],
];

const DEMO_MAP: NonNullable<Snapshot['map']> = {
    cols: MAP_TILES[0]!.length,
    rows: MAP_TILES.length,
    tiles: MAP_TILES,
};

/** 타일 중심의 세계 좌표. 시작 위치를 눈으로 세지 않고 타일로 적기 위한 것이다. */
const at = (col: number, row: number): { x: number; y: number } => ({
    x: col * TILE_PX + TILE_PX / 2,
    y: row * TILE_PX + TILE_PX / 2,
});

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** 일정 속도로 걸어간 거리. 프레임 수 × 프레임당 이동량이라 실제 속도가 그대로 화면에 나온다. */
const walked = (frame: number, from: number, until: number, step: number): number =>
    Math.max(0, Math.min(frame, until) - from) * step;

function player(
    id: number,
    x: number,
    y: number,
    options: { isTagger?: boolean; facingX?: number; facingY?: number; effects?: SnapshotPlayer['effects'] } = {},
): SnapshotPlayer {
    return {
        id,
        x: Math.round(x),
        y: Math.round(y),
        facingX: options.facingX ?? 1,
        facingY: options.facingY ?? 0,
        colorIndex: id - 1,
        obscured: false,
        isTagger: options.isTagger ?? false,
        effects: options.effects ?? {},
    };
}

/**
 * 모든 데모가 **스킬을 쓰기 전부터 이미 달리고 있다.** 속도가 붙거나 떨어지는 것은 비교 대상이
 * 있어야 보인다 — 멈춰 있다가 갑자기 움직이면 그게 스킬 때문인지 알 수 없다.
 */
const RUN_UP_START = 4;
const SKILL_FRAME = 34;

/** 남은 비율(1 → 0). 스냅샷의 effect 값은 남은 시간 비율이다. */
const remaining = (frame: number, from: number, length: number): number =>
    clamp01((from + length - frame) / length);

/**
 * 술래의 외형. 붉은 몸에 머리 위 깃발이 달려 있다.
 *
 * 술래가 아주 조금 빠르게 좁혀 온다 — 겹치기 직전에 멈추게 해서 "잡힌다"를 암시하되 몸이
 * 포개지지는 않게 한다. 실제 경기에서는 겹치기 전에 태그 판정이 난다.
 */
function taggerPlayers(frame: number): SnapshotPlayer[] {
    const lane = at(0, 7).y;
    const runnerX = at(5, 7).x + walked(frame, 0, FRAME_COUNT, BASE_STEP);
    const chaserX = Math.min(
        at(3.2, 7).x + walked(frame, 0, FRAME_COUNT, BASE_STEP * 1.12),
        runnerX - BODY_GAP,
    );
    return [
        player(1, runnerX, lane),
        player(2, chaserX, lane, { isTagger: true }),
    ];
}

/** 유체화. 같은 속도로 달리다 스킬 순간부터 실제 배율(3배)만큼 빨라진다. 벽은 못 넘는다. */
function dashPlayers(frame: number): SnapshotPlayer[] {
    const lane = at(0, 7).y;
    const start = at(2, 7).x;
    const x = start
        + walked(frame, RUN_UP_START, SKILL_FRAME, BASE_STEP)
        + walked(frame, SKILL_FRAME, SKILL_FRAME + DASH_FRAMES, DASH_STEP)
        + walked(frame, SKILL_FRAME + DASH_FRAMES, FRAME_COUNT, BASE_STEP);
    const active = frame >= SKILL_FRAME && frame < SKILL_FRAME + DASH_FRAMES;
    return [player(1, x, lane, {
        effects: active ? { [EffectType.Dash]: remaining(frame, SKILL_FRAME, DASH_FRAMES) } : {},
    })];
}

/** 점멸. 달려오다 6열의 벽을 넘는다. 벽을 통과하는 것이 이 스킬의 전부다. */
function flashPlayers(frame: number): SnapshotPlayer[] {
    const lane = at(0, 3).y;
    const start = at(3.4, 3).x;
    const before = start + walked(frame, RUN_UP_START, SKILL_FRAME, BASE_STEP);
    const landing = before + SKILL_TUNING.FLASH_DISTANCE_TILES * TILE_PX;
    const x = frame < SKILL_FRAME ? before : landing + walked(frame, SKILL_FRAME, FRAME_COUNT, BASE_STEP);
    return [player(1, x, lane)];
}

/** 탈진. 나란히 달리다 맞은 쪽만 실제 배율(0.6배)로 느려진다. */
function exhaustPlayers(frame: number): SnapshotPlayer[] {
    const lane = at(0, 7).y;
    const casterX = at(2, 7).x + walked(frame, RUN_UP_START, FRAME_COUNT, BASE_STEP);
    const victimX = at(2, 7).x + BODY_GAP * 1.6
        + walked(frame, RUN_UP_START, SKILL_FRAME, BASE_STEP)
        + walked(frame, SKILL_FRAME, SKILL_FRAME + EXHAUST_FRAMES, EXHAUST_STEP)
        + walked(frame, SKILL_FRAME + EXHAUST_FRAMES, FRAME_COUNT, BASE_STEP);
    const slowed = frame >= SKILL_FRAME && frame < SKILL_FRAME + EXHAUST_FRAMES;
    return [
        // 느려진 쪽을 시전자가 따라잡되 몸이 겹치지는 않게 한다.
        player(1, Math.min(casterX, victimX - BODY_GAP), lane),
        player(2, victimX, lane, {
            effects: slowed ? { [EffectType.Exhaust]: remaining(frame, SKILL_FRAME, EXHAUST_FRAMES) } : {},
        }),
    ];
}

/** 스위치. 술래에게 쫓기다 사거리 안에서 맵 반대편의 러너를 지목한다. */
function switchPlayers(frame: number): SnapshotPlayer[] {
    const lane = at(0, 7).y;
    const bystander = at(13, 1);
    const casterBefore = at(4, 7).x + walked(frame, RUN_UP_START, SKILL_FRAME, BASE_STEP);
    const chaserBefore = Math.min(
        at(2.6, 7).x + walked(frame, RUN_UP_START, SKILL_FRAME, BASE_STEP * 1.15),
        casterBefore - BODY_GAP,
    );

    if (frame < SKILL_FRAME) {
        return [
            player(1, casterBefore, lane),
            player(2, chaserBefore, lane, { isTagger: true }),
            player(3, bystander.x, bystander.y, { facingX: 0, facingY: 1 }),
        ];
    }

    const castAt = at(4, 7).x + walked(SKILL_FRAME, RUN_UP_START, SKILL_FRAME, BASE_STEP);
    const chaserAt = Math.min(
        at(2.6, 7).x + walked(SKILL_FRAME, RUN_UP_START, SKILL_FRAME, BASE_STEP * 1.15),
        castAt - BODY_GAP,
    );
    const fade = remaining(frame, SKILL_FRAME, FRENZY_FRAMES);
    return [
        // 시전자는 러너로 남는다. 광란을 받아 반대 방향으로 빠져나간다.
        player(1, castAt + walked(frame, SKILL_FRAME, FRAME_COUNT, FRENZY_STEP), lane, {
            effects: { [EffectType.Frenzy]: fade },
        }),
        // 강등된 술래는 감속을 받아 뒤처진다.
        player(2, chaserAt + walked(frame, SKILL_FRAME, SKILL_FRAME + EXHAUST_FRAMES, EXHAUST_STEP), lane, {
            effects: { [EffectType.Exhaust]: remaining(frame, SKILL_FRAME, EXHAUST_FRAMES) },
        }),
        // 맵 반대편에서 방심하던 사람이 새 술래가 된다. 이 스킬의 요점이다.
        player(3, bystander.x, bystander.y, {
            isTagger: true, facingX: 0, facingY: 1,
            effects: { [EffectType.Frenzy]: fade },
        }),
    ];
}

const playerFactories: Record<DemoId, (frame: number) => SnapshotPlayer[]> = {
    tagger: taggerPlayers,
    dash: dashPlayers,
    flash: flashPlayers,
    exhaust: exhaustPlayers,
    switch: switchPlayers,
};

/** 자동 재생을 껐을 때 보여 줄 한 프레임. 스킬이 막 걸린 직후여야 무엇을 설명하는지 읽힌다. */
const posterFrames: Record<DemoId, number> = {
    tagger: 70,
    dash: SKILL_FRAME + 8,
    flash: SKILL_FRAME + 4,
    exhaust: SKILL_FRAME + 20,
    switch: SKILL_FRAME + 12,
};

/**
 * 데모마다 보여 줄 맵의 부분. 타일 좌표로 적고 세계 좌표로 바꾼다.
 *
 * 사거리 원이 있는 스킬은 원이 화면 밖으로 잘리지 않을 만큼 넓게 잡는다 — 탈진의 사거리는
 * 4타일이라 지름이 8타일이다. 좁게 잡으면 원이 배경처럼 보이고 "범위"로 읽히지 않는다.
 */
const VIEWS: Record<DemoId, { col: number; row: number; cols: number; rows: number }> = {
    // 술래는 몸과 깃발을 봐야 하므로 가깝게 잡는다.
    tagger: { col: 3, row: 6, cols: 6, rows: 2.4 },
    dash: { col: 1.4, row: 5.6, cols: 12, rows: 3 },
    flash: { col: 3, row: 1.6, cols: 8, rows: 3.2 },
    exhaust: { col: 1.4, row: 5.6, cols: 9, rows: 3 },
    switch: { col: 1, row: 0.6, cols: 14, rows: 7.6 },
};

function snapshot(id: DemoId, frame: number, full: boolean): Snapshot {
    return {
        version: PROTOCOL_VERSION,
        full,
        tick: frame + 1,
        ...(full ? {
            map: DEMO_MAP,
            // 자기장은 맵 전체를 덮는다. 데모에 붉은 테두리가 보이면 "여기가 끝"으로 읽히는데
            // 이 화면이 설명하는 것은 자기장이 아니다.
            storm: {
                x: 0,
                y: 0,
                width: DEMO_MAP.cols * TILE_PX,
                height: DEMO_MAP.rows * TILE_PX,
            },
            selfId: 1,
            roster: [
                { id: 1, nickname: '' },
                { id: 2, nickname: '' },
                { id: 3, nickname: '' },
            ],
        } : {}),
        players: playerFactories[id](frame),
    };
}

function eventAt(id: DemoId, frame: number): DemoEvent | undefined {
    if (frame !== SKILL_FRAME) return undefined;
    if (id === 'flash') {
        const from = flashPlayers(SKILL_FRAME - 1)[0]!;
        return { blink: { playerId: 1, fromX: from.x, fromY: from.y } };
    }
    if (id === 'exhaust') {
        const from = exhaustPlayers(SKILL_FRAME)[0]!;
        // 탈진은 실제로 맞은 사람의 색으로 그린다. 사거리도 서버와 같은 값이다.
        return {
            skillArea: {
                playerId: 1, x: from.x, y: from.y, affectedPlayerId: 2,
                rangePx: SKILL_TUNING.EXHAUST_RANGE_TILES * TILE_PX,
            },
        };
    }
    if (id === 'switch') {
        const from = switchPlayers(SKILL_FRAME)[0]!;
        // 스위치는 지목한 사람의 색이다. 사거리는 술래와의 거리를 재는 값이다.
        return {
            skillArea: {
                playerId: 1, x: from.x, y: from.y, affectedPlayerId: 3,
                rangePx: SKILL_TUNING.SWITCH_RANGE_TILES * TILE_PX,
            },
        };
    }
    return undefined;
}

function viewOf(id: DemoId): HelpDemoTimeline['view'] {
    const view = VIEWS[id];
    return { x: view.col * TILE_PX, y: view.row * TILE_PX, width: view.cols * TILE_PX, height: view.rows * TILE_PX };
}

function buildTimeline(id: DemoId): HelpDemoTimeline {
    const frames = Array.from({ length: FRAME_COUNT }, (_, frame): EncodedDemoFrame => {
        const event = eventAt(id, frame);
        return {
            buffer: encodeSnapshot(snapshot(id, frame, frame === 0)),
            ...(event ? { event } : {}),
        };
    });
    return {
        frames,
        // 자동 재생을 끈 화면은 보간 버퍼를 거치지 않아야 정말 한 프레임으로 멈춘다.
        poster: encodeSnapshot(snapshot(id, posterFrames[id], true)),
        view: viewOf(id),
    };
}

export const HELP_DEMO_TIMELINES: Readonly<Record<DemoId, HelpDemoTimeline>> = Object.fromEntries(
    ALL_DEMO_IDS.map((id) => [id, buildTimeline(id)]),
) as Record<DemoId, HelpDemoTimeline>;
