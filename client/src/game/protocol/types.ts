import { EffectType, type TilePhysics } from '../types.ts';

/** Bumped only on a breaking layout change; unknown sections are skipped, so additions don't need it. */
export const PROTOCOL_VERSION = 1;

export const SectionType = {
    Map: 0x01,
    TileChanges: 0x02,
    TileAlphas: 0x03,
    Storm: 0x04,
    Players: 0x05,
    Regions: 0x06,
    Self: 0x07,
    Events: 0x08,
    Roster: 0x09,
} as const;
export type SectionType = (typeof SectionType)[keyof typeof SectionType];

export const SnapshotFlags = {
    /** Whole-world snapshot rather than an incremental frame — carries MAP/ROSTER. */
    Full: 0x01,
} as const;

/**
 * No "out of bounds" flag: the storm is a solid boundary the server collides players against, so being
 * outside it is not a reachable state and there'd be nothing to signal.
 */
export const PlayerFlags = {
    Obscured: 0x01,
    Tagger: 0x02,
    HasEmoji: 0x04,
} as const;

export const EventType = {
    Blink: 0x01,
} as const;

/**
 * Bit position of each effect inside a player record's `effectMask`. Order is part of the wire format —
 * appending is fine, reordering is not.
 */
export const EFFECT_BITS: readonly EffectType[] = [EffectType.Dash, EffectType.Frenzy, EffectType.Exhaust];

export interface SnapshotPlayer {
    id: number;
    x: number;
    y: number;
    facingX: number;
    facingY: number;
    colorIndex: number;
    obscured: boolean;
    isTagger: boolean;
    /** 0..1 per active effect. Absent keys are inactive. */
    effects: Partial<Record<EffectType, number>>;
    emojiId?: number;
}

export interface SnapshotBlink {
    type: typeof EventType.Blink;
    playerId: number;
    fromX: number;
    fromY: number;
}

export type SnapshotEvent = SnapshotBlink;

/**
 * A decoded frame. Every field is optional because a delta frame carries only what changed — but
 * `players`, when present, is **authoritative**: anyone missing from it is no longer visible and gets
 * removed. That's the whole basis of the "can't see it, was never sent it" model.
 */
export interface Snapshot {
    version: number;
    full: boolean;
    tick: number;
    map?: { cols: number; rows: number; tiles: TilePhysics[][] };
    tileChanges?: { x: number; y: number; physics: TilePhysics }[];
    tileAlphas?: { x: number; y: number; alpha: number }[];
    storm?: { x: number; y: number; width: number; height: number } | null;
    players?: SnapshotPlayer[];
    regions?: { x: number; y: number; remaining: number }[];
    selfId?: number;
    events?: SnapshotEvent[];
    roster?: { id: number; nickname: string }[];
}
