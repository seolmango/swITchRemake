import type { ColorVisionMode } from '../theme/cvd.ts';

// Engine-facing data types. Kept independent from `shared` (still an empty
// scaffold package as of writing) so the renderer has no compile-time
// dependency on netcode/protocol work that hasn't landed yet. Shapes here
// intentionally mirror the field names used in the map/game-design docs so a
// future `shared` adapter is a thin re-export, not a rewrite.

/** Per-tile physics category. Matches tools/MapBuilder's `physics` values. */
export const TilePhysics = {
    Floor: 0,
    Wall: 1,
    Bush: 2,
    Gas: 3,
} as const;
export type TilePhysics = (typeof TilePhysics)[keyof typeof TilePhysics];

/** A concealment tile group (flood-filled bush/gas blob) the renderer draws as one blob. */
export interface RegionState {
    /** 1 = fully present/opaque, 0 = fully dissipated. Caller-driven (the renderer has no timers of its own). */
    remaining: number;
}

export interface RegionInfo {
    id: string;
    physics: typeof TilePhysics.Bush | typeof TilePhysics.Gas;
    tiles: readonly (readonly [number, number])[];
    /** World-space center, in px. */
    centerX: number;
    centerY: number;
}

export interface MapView {
    cols: number;
    rows: number;
    /** [row][col], TilePhysics values. */
    tiles: readonly (readonly TilePhysics[])[];
}

export const EffectType = {
    Dash: 'dash',
    Frenzy: 'frenzy',
    Exhaust: 'exhaust',
} as const;
export type EffectType = (typeof EffectType)[keyof typeof EffectType];

export interface EffectState {
    /** Seconds (or any consistent unit) remaining; only used against `total` to compute a fill ratio. */
    remaining: number;
    total: number;
}

/** 0 = light, 1 = dark — matches useSettingsStore's `theme` field. */
export type Theme = 0 | 1;

export interface PlayerInit {
    x: number;
    y: number;
    facingX?: number;
    facingY?: number;
    /** Index into Color.user — which of the 8 palette slots this player renders as. */
    colorIndex: number;
    /** In-body number. Defaults to `id + 1`. */
    label?: string;
    /** Display name from the roster. Only rendered when `DisplayOptions.showNickname` is on. */
    nickname?: string;
}

export type CameraMode = 'follow' | 'free';

export interface StormRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** 'light' is the demo's "바닥 옅게" toggle — a slightly brighter floor tint, light theme only. */
export type FloorVariant = 'default' | 'light';

/**
 * How the engine is being used. Not a rendering switch — the world draws identically in all three;
 * this gates input, camera defaults, and which HUD the React shell puts on top. See docs/ENGINE.md.
 */
export const EngineMode = {
    /** Playing: a self player exists, camera follows them, movement + skill input is live. */
    Play: 'play',
    /** Watching: no self player, free camera, camera controls only. */
    Spectate: 'spectate',
    /** Tutorial: driven by a local script instead of a server socket. */
    Help: 'help',
} as const;
export type EngineMode = (typeof EngineMode)[keyof typeof EngineMode];

/** Purely local view preferences — never sent anywhere, never affects what the server reveals. */
export interface DisplayOptions {
    /** The 1-based number inside the body circle. */
    showNumber: boolean;
    /** The nickname above the head. Needs a roster to have supplied one. */
    showNickname: boolean;
}

export const DEFAULT_DISPLAY_OPTIONS: DisplayOptions = {
    showNumber: true,
    showNickname: false,
};

// ---- 로컬 렌더 설정 ----
// 아래는 전부 유저 설정(useSettingsStore)에서 내려오는, 순수하게 클라이언트 로컬인 값이다.
// 서버로 나가지 않고, 서버가 보내주는 정보의 양도 바꾸지 않는다 — 같은 정보를 어떻게 그릴지만 정한다.

/** 장식용 움직임의 강도. `reduced`는 접근성용(전정기관 자극 최소화)이라 코스메틱 애니메이션을 완전히 멈춘다. */
export type MotionLevel = 'reduced' | 'standard' | 'full';

/** 프레임당 그리는 디테일의 양. 정보를 지우지 않고 밀도만 낮춘다 — 낮음에서도 수풀/연막/자기장은 그대로 보인다. */
export type QualityLevel = 'low' | 'medium' | 'high';

export type { ColorVisionMode };

export interface EngineSettings {
    /** 초당 프레임 상한. 0이면 제한 없음(브라우저 vsync). */
    frameRate: number;
    /** 내부 렌더 해상도 배율. 1 = CSS 픽셀과 1:1. 시야각은 바뀌지 않고 픽셀 밀도만 바뀐다. */
    resolutionScale: number;
    motion: MotionLevel;
    quality: QualityLevel;
    colorVision: ColorVisionMode;
    /** 광란 중 카메라 미세 진동. */
    screenShake: boolean;
    /** 끄면 팔로우 카메라가 지연 없이 바로 따라붙는다. */
    cameraSmoothing: boolean;
    /** 점멸 시 화면 플래시, 술래 맥동, 자기장 테두리 맥동을 끈다. */
    reduceFlash: boolean;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
    frameRate: 60,
    resolutionScale: 1,
    motion: 'standard',
    quality: 'high',
    colorVision: 'off',
    screenShake: true,
    cameraSmoothing: true,
    reduceFlash: false,
};
