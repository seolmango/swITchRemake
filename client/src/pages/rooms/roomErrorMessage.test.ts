import { describe, expect, it } from 'vitest';
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
