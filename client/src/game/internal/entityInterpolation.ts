export interface EntityPosition {
    id: number;
    x: number;
    y: number;
}

export interface PositionSample {
    tick: number;
    x: number;
    y: number;
}

export type EntityPositionBuffers = ReadonlyMap<number, readonly PositionSample[]>;

/**
 * Rendering one 30 Hz snapshot behind gives the next snapshot roughly 33 ms to arrive, while avoiding
 * the extra input latency of a deeper buffer. Snapshot ticks, not packet arrival timestamps, define the
 * interpolation axis below.
 */
export const ENTITY_INTERPOLATION_DELAY_MS = 1_000 / 30;

const MAX_SAMPLES_PER_ENTITY = 8;

/**
 * A renderer may receive a multi-second rAF gap after a background-tab resume. Advancing at most this
 * much wall time per frame prevents that single callback from racing across the interpolation buffer.
 */
export const RENDER_TICK_MAX_DELTA_MS = 100;

/**
 * Correct one second's worth of clock error per second. Combined with the rate limit below, this is
 * fast enough to remove ordinary scheduler drift without copying per-snapshot arrival jitter to motion.
 */
export const RENDER_TICK_CONVERGENCE_PER_SECOND = 1;

/**
 * Keep time-warp within five percent of normal playback, which is below a noticeable speed change while
 * still correcting a one-percent client/server clock mismatch with ample headroom.
 */
export const RENDER_TICK_MAX_RATE_ADJUSTMENT = 0.05;

/**
 * Half a second is far beyond the one-snapshot interpolation delay. Recovering such a gap at five percent
 * would leave a resumed tab visibly stale for many seconds, so reset the clock instead.
 */
export const RENDER_TICK_HARD_RESET_MS = 500;

export interface BufferEntityPositionsOptions {
    forceSnapIds?: ReadonlySet<number>;
    maxInterpolationDistance: number;
}

export interface BufferedEntityPositions {
    buffers: EntityPositionBuffers;
    snappedIds: ReadonlySet<number>;
}

function distanceSquared(a: PositionSample, b: PositionSample): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return dx * dx + dy * dy;
}

/**
 * Rebuilds the buffers from an authoritative players section. IDs missing from `positions` are omitted,
 * which makes visibility removal and interpolation-buffer cleanup the same deterministic operation.
 */
export function bufferEntityPositions(
    previous: EntityPositionBuffers,
    tick: number,
    positions: readonly EntityPosition[],
    options: BufferEntityPositionsOptions,
): BufferedEntityPositions {
    const buffers = new Map<number, readonly PositionSample[]>();
    const snappedIds = new Set<number>();
    const maxDistanceSquared = options.maxInterpolationDistance * options.maxInterpolationDistance;

    for (const position of positions) {
        const next: PositionSample = { tick, x: position.x, y: position.y };
        const existing = previous.get(position.id) ?? [];
        const latest = existing.at(-1);
        const forceSnap = options.forceSnapIds?.has(position.id) === true;
        const jumpedTooFar = latest !== undefined && distanceSquared(latest, next) >= maxDistanceSquared;

        if (latest === undefined || forceSnap || jumpedTooFar || tick < latest.tick) {
            buffers.set(position.id, [next]);
            snappedIds.add(position.id);
            continue;
        }

        if (tick === latest.tick) {
            buffers.set(position.id, [...existing.slice(0, -1), next]);
            continue;
        }

        buffers.set(position.id, [...existing, next].slice(-MAX_SAMPLES_PER_ENTITY));
    }

    return { buffers, snappedIds };
}

/** Samples between authoritative ticks and deliberately holds the last sample instead of extrapolating. */
export function interpolateEntityPosition(
    samples: readonly PositionSample[],
    renderTick: number,
): { x: number; y: number } | null {
    const first = samples[0];
    if (first === undefined) return null;
    if (samples.length === 1 || renderTick <= first.tick) return { x: first.x, y: first.y };

    const last = samples.at(-1)!;
    if (renderTick >= last.tick) return { x: last.x, y: last.y };

    for (let index = 1; index < samples.length; index += 1) {
        const to = samples[index]!;
        if (renderTick > to.tick) continue;
        const from = samples[index - 1]!;
        const span = to.tick - from.tick;
        if (span <= 0) return { x: to.x, y: to.y };
        const alpha = (renderTick - from.tick) / span;
        return {
            x: from.x + (to.x - from.x) * alpha,
            y: from.y + (to.y - from.y) * alpha,
        };
    }

    return { x: last.x, y: last.y };
}

/**
 * Advances a smooth server-tick render clock toward the delayed authoritative target. Time-warp is bounded
 * so snapshot-arrival jitter is not copied into entity motion; a large background-resume-sized gap resets.
 */
export function advanceRenderTick(
    renderTick: number | null,
    latestSnapshotTick: number,
    deltaMs: number,
    simulationHz: number,
    delayMs = ENTITY_INTERPOLATION_DELAY_MS,
): number {
    const targetTick = latestSnapshotTick - (delayMs / 1_000) * simulationHz;
    if (renderTick === null) return targetTick;

    const maxResetErrorTicks = (RENDER_TICK_HARD_RESET_MS / 1_000) * simulationHz;
    if (Math.abs(targetTick - renderTick) > maxResetErrorTicks) return targetTick;

    const elapsedSeconds = Math.min(Math.max(0, deltaMs), RENDER_TICK_MAX_DELTA_MS) / 1_000;
    const normalAdvance = elapsedSeconds * simulationHz;
    const uncorrectedTick = renderTick + normalAdvance;
    const correction = Math.max(
        -normalAdvance * RENDER_TICK_MAX_RATE_ADJUSTMENT,
        Math.min(
            normalAdvance * RENDER_TICK_MAX_RATE_ADJUSTMENT,
            (targetTick - uncorrectedTick) * RENDER_TICK_CONVERGENCE_PER_SECOND * elapsedSeconds,
        ),
    );
    return uncorrectedTick + correction;
}
