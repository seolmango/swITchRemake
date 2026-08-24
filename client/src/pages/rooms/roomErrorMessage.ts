import { ApiError } from '../../api/http.ts';

type Translate = (key: string, options?: Record<string, number>) => string;

const ERROR_KEYS: Readonly<Record<string, string>> = {
    ROOM_UNAVAILABLE: 'rooms.errors.roomUnavailable',
    NO_JOINABLE_ROOM: 'rooms.errors.noJoinableRoom',
    ROOM_FULL: 'rooms.errors.roomFull',
    JOIN_RATE_LIMITED: 'rooms.errors.joinRateLimited',
    REJOIN_COOLDOWN: 'rooms.errors.rejoinCooldown',
    RejoinCooldown: 'rooms.errors.rejoinCooldown',
    KICKED_FROM_ROOM: 'rooms.errors.kickedFromRoom',
    KickedFromRoom: 'rooms.errors.kickedFromRoom',
    ACTIVE_ROOM_MISSING: 'lobby.resumeFailed',
};

/** Maps room API failures to a user-safe message and preserves an unknown-code fallback. */
export function roomErrorMessage(error: unknown, t: Translate): string {
    const code = error instanceof ApiError ? error.code : error instanceof Error ? error.message : null;
    const key = code === null ? undefined : ERROR_KEYS[code];
    if (key !== undefined) {
        if (key === 'rooms.errors.joinRateLimited' && error instanceof ApiError && error.retryAfterMs !== null) {
            return t('rooms.errors.joinRateLimitedRetry', { seconds: Math.max(1, Math.ceil(error.retryAfterMs / 1_000)) });
        }
        return t(key);
    }
    if (error instanceof ApiError && error.status === 429) {
        if (error.retryAfterMs !== null) {
            return t('rooms.errors.joinRateLimitedRetry', { seconds: Math.max(1, Math.ceil(error.retryAfterMs / 1_000)) });
        }
        return t('rooms.errors.joinRateLimited');
    }
    return t('auth.serverError');
}
