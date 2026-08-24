export const RECONNECT_INITIAL_DELAY_MS = 250;
export const RECONNECT_MAX_DELAY_MS = 2_000;
/** The server retains the seat for 10 seconds; stop locally at 9 seconds to leave scheduling margin. */
export const RECONNECT_MAX_ELAPSED_MS = 9_000;

export function reconnectDelayMs(attempt: number, elapsedMs: number): number | null {
    const remaining = RECONNECT_MAX_ELAPSED_MS - elapsedMs;
    if (remaining <= 0) return null;
    const exponential = RECONNECT_INITIAL_DELAY_MS * 2 ** Math.max(0, attempt);
    return Math.min(RECONNECT_MAX_DELAY_MS, exponential, remaining);
}
