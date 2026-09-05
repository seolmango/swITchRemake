import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock('./http.ts', () => ({ apiRequest, replaceGuestWithAccount: vi.fn() }));

import { registerUser, type RegistrationRequest } from './auth.ts';

describe('가입 요청', () => {
    beforeEach(() => vi.clearAllMocks());

    it('두 문서의 버전과 동의 시점을 서버 요청에 함께 보낸다', async () => {
        apiRequest.mockResolvedValueOnce({ nickname: '테스터' });
        const request: RegistrationRequest = {
            email: 'test@example.com',
            password: 'Password1!',
            nickname: '테스터',
            code: '123456',
            agreements: {
                termsOfService: { version: '1.0 (초안)', acceptedAt: '2026-09-05T00:00:00.000Z' },
                privacyPolicy: { version: '1.0 (초안)', acceptedAt: '2026-09-05T00:01:00.000Z' },
            },
        };

        await registerUser(request);

        expect(apiRequest).toHaveBeenCalledWith('/users/register', {
            method: 'POST',
            auth: false,
            retryAuth: false,
            body: request,
        });
    });
});
