import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/http.ts';
import { loginErrorMessage } from './authErrorMessage.ts';

const t = (key: string) => key;

describe('loginErrorMessage', () => {
    it('maps the server-authoritative active-room conflict to its dedicated message', () => {
        expect(loginErrorMessage(new ApiError(409, { code: 'IDENTITY_SWITCH_DURING_ROOM' }), t))
            .toBe('auth.identitySwitchDuringRoom');
    });
});
