/**
 * Phaser's limiter accumulates rAF deltas until a threshold and then discards the remainder. Enabling it
 * at the common 60/120 Hz choices can therefore alternate short and skipped frames. Only the explicit
 * low-power 30 fps mode needs callback limiting; normal modes should follow the display's rAF cadence.
 */
export function phaserFpsLimit(frameRate: number): number {
    return frameRate > 0 && frameRate < 60 ? frameRate : 0;
}
