/**
 * Converts a time-domain half-life into the lerp fraction for one rendered frame.
 * Keeping the tuning in milliseconds makes camera response independent of refresh rate.
 */
export function cameraFollowLerp(deltaMs: number, halfLifeMs: number): number {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 0;
    if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return 1;
    // A background-tab gap should catch up quickly without becoming an unbounded numerical jump.
    const boundedDeltaMs = Math.min(deltaMs, 100);
    return 1 - Math.pow(0.5, boundedDeltaMs / halfLifeMs);
}
