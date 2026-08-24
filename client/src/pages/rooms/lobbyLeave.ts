const LOBBY_LEAVE_DELAY_MS = 100;

const pendingLeaves = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * React development StrictMode intentionally unmounts and immediately remounts effects.
 * A 100 ms grace period lets that synchronous remount cancel the synthetic leave,
 * while a real navigation away from the lobby still releases the seat promptly.
 */
export function scheduleLobbyLeave(roomId: string, leave: () => void): void {
    if (pendingLeaves.has(roomId)) return;
    const timer = setTimeout(() => {
        pendingLeaves.delete(roomId);
        leave();
    }, LOBBY_LEAVE_DELAY_MS);
    pendingLeaves.set(roomId, timer);
}

export function cancelScheduledLobbyLeave(roomId: string): void {
    const timer = pendingLeaves.get(roomId);
    if (timer === undefined) return;
    clearTimeout(timer);
    pendingLeaves.delete(roomId);
}
