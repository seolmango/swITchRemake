import {
    EffectType,
    PROTOCOL_VERSION,
    TilePhysics,
    encodeSnapshot,
    type Snapshot,
    type SnapshotPlayer,
} from 'shared';

export const HELP_DEMO_HZ = 30;
export const HELP_DEMO_FRAME_MS = 1_000 / HELP_DEMO_HZ;
const FRAME_COUNT = 120;

/**
 * 이 게임에 실제로 있는 스킬은 넷이다(`shared`의 `SkillId`). 여기에 없는 것을 넣으면
 * 도움말이 존재하지 않는 조작을 가르친다.
 */
export const HELP_DEMO_IDS = ['dash', 'flash', 'exhaust', 'switch'] as const;
export type HelpDemoId = (typeof HELP_DEMO_IDS)[number];

interface DemoEvent {
    blink?: { playerId: number; fromX: number; fromY: number };
}

export interface EncodedDemoFrame {
    buffer: ArrayBuffer;
    event?: DemoEvent;
}

export interface HelpDemoTimeline {
    frames: readonly EncodedDemoFrame[];
    poster: ArrayBuffer;
}

const MAP_TILES: TilePhysics[][] = [
    [1, 1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 1],
];

const DEMO_MAP: NonNullable<Snapshot['map']> = {
    cols: MAP_TILES[0]!.length,
    rows: MAP_TILES.length,
    tiles: MAP_TILES,
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function between(frame: number, start: number, end: number, from: number, to: number): number {
    if (frame <= start) return from;
    if (frame >= end) return to;
    return from + (to - from) * clamp01((frame - start) / (end - start));
}

function player(
    id: number,
    x: number,
    y: number,
    options: Partial<Pick<SnapshotPlayer, 'facingX' | 'facingY' | 'isTagger' | 'effects'>> = {},
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

function dashPlayers(frame: number): SnapshotPlayer[] {
    const active = frame >= 24 && frame <= 43;
    return [player(1, between(frame, 24, 35, 410, 910), 640, {
        effects: active ? { [EffectType.Dash]: clamp01((44 - frame) / 20) } : {},
    })];
}

function flashPlayers(frame: number): SnapshotPlayer[] {
    return [player(1, frame < 38 ? 650 : 1450, 640)];
}

function exhaustPlayers(frame: number): SnapshotPlayer[] {
    const targetX = frame < 34
        ? between(frame, 8, 34, 760, 1_070)
        : between(frame, 34, 92, 1_070, 1_330);
    const exhausted = frame >= 34 && frame <= 92;
    return [
        player(1, 560, 640),
        player(2, targetX, 640, {
            effects: exhausted ? { [EffectType.Exhaust]: clamp01((93 - frame) / 59) } : {},
        }),
    ];
}

function switchPlayers(frame: number): SnapshotPlayer[] {
    if (frame < 42) {
        return [
            player(1, 650, 640),
            player(2, 870, 640, { isTagger: true }),
            player(3, 1_560, 384),
        ];
    }
    return [
        player(1, between(frame, 42, 82, 650, 420), 640, {
            effects: { [EffectType.Frenzy]: clamp01((96 - frame) / 54) },
        }),
        player(2, between(frame, 42, 82, 870, 1_030), 640, {
            effects: { [EffectType.Exhaust]: clamp01((96 - frame) / 54) },
        }),
        player(3, 1_560, 384, {
            isTagger: true,
            effects: { [EffectType.Frenzy]: clamp01((96 - frame) / 54) },
        }),
    ];
}

const playerFactories: Record<HelpDemoId, (frame: number) => SnapshotPlayer[]> = {
    dash: dashPlayers,
    flash: flashPlayers,
    exhaust: exhaustPlayers,
    switch: switchPlayers,
};

const posterFrames: Record<HelpDemoId, number> = {
    dash: 35,
    flash: 38,
    exhaust: 58,
    switch: 58,
};

function snapshot(id: HelpDemoId, frame: number, full: boolean): Snapshot {
    return {
        version: PROTOCOL_VERSION,
        full,
        tick: frame + 1,
        ...(full ? {
            map: DEMO_MAP,
            storm: { x: 256, y: 256, width: 1_536, height: 768 },
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

function eventAt(id: HelpDemoId, frame: number): DemoEvent | undefined {
    if (id === 'flash' && frame === 38) {
        return { blink: { playerId: 1, fromX: 650, fromY: 640 } };
    }
    return undefined;
}

function buildTimeline(id: HelpDemoId): HelpDemoTimeline {
    const frames = Array.from({ length: FRAME_COUNT }, (_, frame): EncodedDemoFrame => {
        const event = eventAt(id, frame);
        return {
            buffer: encodeSnapshot(snapshot(id, frame, frame === 0)),
            ...(event ? { event } : {}),
        };
    });
    const posterFrame = posterFrames[id];
    return {
        frames,
        // 자동 재생을 끈 화면은 보간 버퍼를 거치지 않아야 정말 한 프레임으로 멈춘다.
        poster: encodeSnapshot(snapshot(id, posterFrame, true)),
    };
}

export const HELP_DEMO_TIMELINES: Readonly<Record<HelpDemoId, HelpDemoTimeline>> = Object.fromEntries(
    HELP_DEMO_IDS.map((id) => [id, buildTimeline(id)]),
) as Record<HelpDemoId, HelpDemoTimeline>;
