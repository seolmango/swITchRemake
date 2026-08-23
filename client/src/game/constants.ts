import { EffectType } from './types.ts';

/** Real world tile size in px — matches tools/MapBuilder (256x256 tile assets, start_pos formula tileIndex*256+128). */
export const TILE_SIZE = 256;

/** How far past the map's true edge the world extends — lets the storm danger-zone render a visible
 * border from tick 0 (instead of a hard cutoff exactly at the map edge) and gives the camera's bounds
 * some breathing room instead of clamping flush against the map. Nothing gameplay-relevant lives out here. */
export const WORLD_MARGIN_TILES = 5;

/** The visual reference demo (source of every proportion below) used 40px tiles. Keep every metric
 * expressed as `px(demoValue)` so proportions stay traceable back to that reference instead of being
 * re-eyeballed at the new scale. */
const DEMO_TILE_PX = 40;
export const SCALE = TILE_SIZE / DEMO_TILE_PX;
const px = (demoValue: number): number => demoValue * SCALE;

export const PLAYER = {
    radius: px(15),
    outlineWidth: px(3),
    labelFontPx: px(15),
    nameplateFontPx: px(13),
    /** Gap between the bar stack's top and the nickname's baseline. */
    nameplateGap: px(5),
    selectionRingOffset: px(13),
    selectionRingLineWidth: px(1.5),
    selectionRingDash: [px(3), px(5)] as [number, number],
};

/**
 * Concealment rendering. The engine does NO concealment logic of its own — it never inspects tiles to
 * decide who is hidden or how see-through anything is. It only renders two caller-supplied facts:
 * a player's `obscured` flag (drawn at `playerAlpha`) and per-tile alphas (`MapLayer.setTileAlphas`).
 * Anyone the viewer genuinely cannot see is simply never sent, so the engine never has to hide them.
 */
export const CONCEAL = {
    /** Body alpha for a player the caller marked `obscured` — matches legacy's `globalAlpha = 0.6`. */
    playerAlpha: 0.6,
    /** Per-tile alphas are snapped to 1/N on ingest, bounding how many draw batches a frame can split into. */
    alphaQuantSteps: 32,
};

export const DASH_FX = {
    rings: 3,
    baseOffset: px(10),
    ringStep: px(7),
    lineWidthBase: px(3.2),
    lineWidthStep: px(0.7),
    arcSpan: 0.7,
    pulseAmplitude: px(1.5),
};

export const EXHAUST_FX = {
    drops: 2,
    spacingX: px(14),
    riseY: px(7),
    fallY: px(9),
    dropRadius: px(2.6),
};

export const FRENZY_FX = {
    teeth: 16,
    outerInset: px(1.5),
    innerInset: px(8),
    lineWidth: px(2.2),
    rotSpeed: 1.9,
};

export const TAGGER = {
    ringWidth: px(5),
    pulseLineWidth: px(2.5),
    pulseInset: px(4),
    pulseRange: px(8),
    flagHalfWidth: px(6.5),
    flagBaseOffsetY: px(6),
    flagTipDrop: px(7),
    flagBaseRise: px(2),
    flagBob: px(2),
    flagBobSpeed: 4,
};

export const BAR = {
    width: px(38),
    height: px(5),
    gap: px(3),
    startOffset: px(12),
    radius: px(2.5),
};

/**
 * Head-above emoji, reproducing legacy's pop (RenderingManager.js:330-337): a 60-frame countdown where
 * the size curve overshoots on the way in, holds, then overshoots and collapses on the way out. Kept as
 * the same piecewise parabola rather than a re-eyeballed ease so the bounce feels identical.
 *
 * Duration is owned by the engine, not the server — an emoji affects nothing in the game, same as the
 * blink trail.
 */
export const EMOJI = {
    lifeSec: 2,
    /** Legacy's hold size, scaled to this project's tiles (legacy: 80*0.6 px against ~100px tiles). */
    holdSize: TILE_SIZE * 0.96,
    /** Gap between whatever the head stack currently reaches (bars, tagger flag) and the emoji's bottom.
     * The stack height is measured per-frame rather than assumed, so the emoji sits just clear of it
     * instead of being parked at a fixed height tall enough for the worst case. */
    gapAboveStack: px(6),
};

export const BLINK_FX = {
    life: 0.55,
    lineWidth: px(2),
    ringLineWidth: px(2.5),
    dash: [px(7), px(7)] as [number, number],
    startRadius: px(15),
    ringGrow: px(22),
};

export const WALL = {
    strokeWidth: px(2),
};

export const GRASS = {
    blades: 5,
    bladeStepX: px(7),
    bladeOffsetX: px(6),
    bladeAltOffsetX: px(2),
    bladeBottomOffset: px(4),
    bladeBottomStep: px(4),
    bladeControlY: px(9),
    bladeHeight: px(17),
    lineWidth: px(2.4),
    blobStrokeWidth: px(2),
    blobCornerRadius: px(15),
};

export const SMOKE = {
    dotSpacing: px(9),
    dotRadius: px(1.4),
    strokeWidth: px(2.5),
    gaugeRadius: px(9),
    gaugeWidth: px(3.4),
    blobCornerRadius: px(15),
};

export const STORM = {
    strokeWidthLight: px(4),
    strokeWidthDark: px(3),
    patternTile: px(14),
    hatchLineWidth: px(2.2),
    pulseSpeed: 3,
    /** Dark-mode hatch pattern drift, world px/sec — purely cosmetic, gives the danger zone a slow "moving" feel. */
    driftSpeedPerSec: px(3),
};

export const FLOOR = {
    gridLineWidth: px(2),
};

export const CAMERA = {
    minZoom: 0.05,
    maxZoom: 4,
    followLerp: 0.15,
    wheelZoomStep: 0.1,
};

/**
 * Reactive camera "juice", driven only by effect state the caller already pushed in — the engine derives
 * nothing about the world on its own (no tile inspection, no concealment). Zoom stays client-owned: these
 * multipliers stack on top of the user-controlled base zoom (`WorldScene.baseZoom`), so wheel zoom and
 * `setCameraZoom` keep working underneath. Zoom is deliberately NOT server-authoritative — a client that
 * tampers with it gains nothing, since players it shouldn't see are never sent in the first place.
 */
export const CAMERA_FX = {
    /** Dash (유체화): wider view, sense of speed. */
    dashZoomMult: 0.9,
    /** Exhaust (탈진): tunnel-vision-ish, tired. */
    exhaustZoomMult: 1.12,
    /** Frenzy (광란): slight tension zoom-in, paired with the shake below. */
    frenzyZoomMult: 1.06,
    /** Exponential-decay rate (per second) the combined zoom multiplier eases toward its target at. */
    zoomLerpSpeed: 6,
    /** Follow smoothing while dashing — snappier than the default so the camera "keeps up". */
    dashLerp: 0.28,
    /** Follow smoothing while exhausted — heavier/slower, reads as sluggish. */
    exhaustLerp: 0.06,
    frenzyShakeIntensity: 0.006,
    frenzyShakeDurationMs: 180,
    /** One-shot zoom "punch" applied on the followed player's own blink (negative = brief zoom-out snap). */
    blinkZoomPunch: -0.18,
    /** Exponential-decay rate (per second) the blink punch eases back to 0 at. */
    blinkPunchDecay: 10,
    blinkFlashDurationMs: 140,
};

/** Players whose position falls further than this outside the camera's world view skip their (relatively
 * expensive, per-frame Graphics redraw) update entirely — generous enough to cover the widest effect
 * ring / bar stack a player can render, so nothing pops in/out visibly at the boundary. */
export const CULL_MARGIN = TILE_SIZE * 2;

export interface EffectVisualDef {
    /** Design-reference duration/multiplier — real values will come from `shared` balance constants once they exist. */
    defaultDurationSec: number;
    speedMultiplier: number;
}

export const EFFECT_DEFS: Record<EffectType, EffectVisualDef> = {
    [EffectType.Dash]: { defaultDurationSec: 6, speedMultiplier: 1.55 },
    [EffectType.Frenzy]: { defaultDurationSec: 8, speedMultiplier: 1.85 },
    [EffectType.Exhaust]: { defaultDurationSec: 5, speedMultiplier: 0.5 },
};

/** Draw order (bottom of the stack up) for the stacked effect bars above a player's head. */
export const EFFECT_BAR_ORDER: EffectType[] = [EffectType.Dash, EffectType.Frenzy, EffectType.Exhaust];
