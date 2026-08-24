import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelScheduledLobbyLeave, scheduleLobbyLeave } from './lobbyLeave.ts';

describe('lobby leave scheduling', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not leave when a same-room remount cancels the cleanup', () => {
        vi.useFakeTimers();
        const leave = vi.fn();

        scheduleLobbyLeave('room-1', leave);
        cancelScheduledLobbyLeave('room-1');
        vi.runAllTimers();

        expect(leave).not.toHaveBeenCalled();
    });

    it('leaves after the grace period when the lobby remains unmounted', () => {
        vi.useFakeTimers();
        const leave = vi.fn();

        scheduleLobbyLeave('room-1', leave);
        vi.runAllTimers();

        expect(leave).toHaveBeenCalledTimes(1);
    });
});
