import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/http.ts';
import { loginErrorMessage, mfaErrorMessage, retryAfterSeconds } from './authErrorMessage.ts';

const t = (key: string) => key;

describe('loginErrorMessage', () => {
    it('maps the server-authoritative active-room conflict to its dedicated message', () => {
        expect(loginErrorMessage(new ApiError(409, { code: 'IDENTITY_SWITCH_DURING_ROOM' }), t))
            .toBe('auth.identitySwitchDuringRoom');
    });
});

describe('mfaErrorMessage', () => {
    it('uses stable server error codes for second-factor failures', () => {
        expect(mfaErrorMessage(new ApiError(401, { code: 'INVALID_SECOND_FACTOR' }), t))
            .toBe('auth.invalidSecondFactor');
        expect(mfaErrorMessage(new ApiError(401, { code: 'INVALID_MFA_CHALLENGE' }), t))
            .toBe('auth.mfaChallengeExpired');
    });

    it('uses retryAfterMs for the rate-limit countdown', () => {
        const error = new ApiError(429, { retryAfterMs: 2_001 });
        expect(retryAfterSeconds(error)).toBe(3);
    });
});
