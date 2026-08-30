import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/http.ts';
import { roomErrorMessage } from './roomErrorMessage.ts';

const t = (key: string, options?: Record<string, number>) => `${key}${options?.seconds === undefined ? '' : `:${options.seconds}`}`;

describe('roomErrorMessage', () => {
    it.each([
        'ROOM_UNAVAILABLE', 'NO_JOINABLE_ROOM', 'ROOM_FULL', 'JOIN_RATE_LIMITED',
        'REJOIN_COOLDOWN', 'RejoinCooldown', 'KICKED_FROM_ROOM', 'KickedFromRoom',
    ])('maps %s to a room message', (code) => {
        expect(roomErrorMessage(new ApiError(409, { code }), t)).not.toBe('auth.serverError');
    });

    it('uses retryAfterMs for rate limits and supports a bare HTTP 429', () => {
        expect(roomErrorMessage(new ApiError(429, { code: 'JOIN_RATE_LIMITED', retryAfterMs: 1_001 }), t))
            .toBe('rooms.errors.joinRateLimitedRetry:2');
        expect(roomErrorMessage(new ApiError(429, {}), t)).toBe('rooms.errors.joinRateLimited');
    });

    it('preserves the active-room message and falls back for unknown codes', () => {
        expect(roomErrorMessage(new Error('ACTIVE_ROOM_MISSING'), t)).toBe('lobby.resumeFailed');
        expect(roomErrorMessage(new ApiError(409, { code: 'FUTURE_CODE' }), t)).toBe('auth.serverError');
    });
});

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
