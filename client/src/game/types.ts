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
