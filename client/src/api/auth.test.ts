import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequest, replaceGuestWithAccount } = vi.hoisted(() => ({ apiRequest: vi.fn(), replaceGuestWithAccount: vi.fn() }));
vi.mock('./http.ts', () => ({ apiRequest, replaceGuestWithAccount }));

import {
    completeMfaLogin,
    changePassword,
    issueHumanChallenge,
    loginUser,
    registerUser,
    resendMfaLoginEmail,
    resetPassword,
    sendVerification,
    verifyHumanChallenge,
    type RegistrationRequest,
} from './auth.ts';

describe('password change session', () => {
    it('installs the access token for the new security epoch', async () => {
        vi.clearAllMocks();
        apiRequest.mockResolvedValueOnce({ revokedCount: 2, accessToken: 'new-epoch', nickname: 'tester' });
        await changePassword({ currentPassword: 'OldExample1!', newPassword: 'NewExample1!' });
        expect(replaceGuestWithAccount).toHaveBeenCalledWith('new-epoch', 'tester');
    });
});

describe('human challenge requests', () => {
    beforeEach(() => vi.clearAllMocks());

    it('binds challenge issue to purpose and email, then submits only the chosen slot', async () => {
        apiRequest.mockResolvedValueOnce({ challengeToken: 'challenge' }).mockResolvedValueOnce({ proofToken: 'proof' });

        await issueHumanChallenge('test@example.com', 'signup');
        await verifyHumanChallenge('challenge', 6);

        expect(apiRequest).toHaveBeenNthCalledWith(1, '/auth/human-challenge', {
            method: 'POST', auth: false, retryAuth: false,
            body: { subject: 'test@example.com', purpose: 'signup' },
        });
        expect(apiRequest).toHaveBeenNthCalledWith(2, '/auth/human-challenge/verify', {
            method: 'POST', auth: false, retryAuth: false,
            body: { challengeToken: 'challenge', selectedSlot: 6 },
        });
    });

    it('includes the one-use proof when requesting an email code', async () => {
        apiRequest.mockResolvedValueOnce({ message: 'sent' });
        await sendVerification('test@example.com', 'reset-password', 'proof');
        expect(apiRequest).toHaveBeenCalledWith('/auth/verify', {
            method: 'POST', auth: false, retryAuth: false,
            body: { email: 'test@example.com', vtype: 'reset-password', humanProof: 'proof' },
        });
    });
});

describe('가입 요청', () => {
    beforeEach(() => vi.clearAllMocks());

    it('두 문서의 버전과 동의 시점을 서버 요청에 함께 보낸다', async () => {
        apiRequest.mockResolvedValueOnce({ nickname: '테스터' });
        const request: RegistrationRequest = {
            isOver14: true,
            email: 'test@example.com',
            password: 'Password1!',
            nickname: '테스터',
            code: '123456',
            agreements: {
                termsOfService: { version: '1.0', acceptedAt: '2026-09-05T00:00:00.000Z' },
                privacyPolicy: { version: '1.0', acceptedAt: '2026-09-05T00:01:00.000Z' },
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

describe('MFA authentication requests', () => {
    beforeEach(() => vi.clearAllMocks());

    it('does not install an account identity until a challenged login is verified', async () => {
        apiRequest.mockResolvedValueOnce({
            mfaRequired: true,
            challengeToken: 'challenge',
            method: 'email',
            expiresIn: 300,
        });

        await expect(loginUser('test@example.com', 'Password1!')).resolves.toMatchObject({ mfaRequired: true });
        expect(replaceGuestWithAccount).not.toHaveBeenCalled();
    });

    it('attaches a human proof only to an escalated login retry', async () => {
        apiRequest.mockResolvedValueOnce({ mfaRequired: false, accessToken: 'access', nickname: 'Tester' });
        await loginUser('test@example.com', 'Password1!', 'proof');
        expect(apiRequest).toHaveBeenCalledWith('/auth/login', {
            method: 'POST',
            retryAuth: false,
            body: { email: 'test@example.com', password: 'Password1!', humanProof: 'proof' },
        });
    });

    it('sends the code and opt-in trust choice, then installs the verified identity', async () => {
        apiRequest.mockResolvedValueOnce({
            mfaRequired: false,
            accessToken: 'access',
            nickname: 'Tester',
        });

        await completeMfaLogin('challenge', '123456', false);

        expect(apiRequest).toHaveBeenCalledWith('/auth/login/mfa', {
            method: 'POST',
            retryAuth: false,
            body: { challengeToken: 'challenge', code: '123456', trustDevice: false },
        });
        expect(replaceGuestWithAccount).toHaveBeenCalledWith('access', 'Tester');
    });

    it('resends email codes against the same in-memory challenge', async () => {
        apiRequest.mockResolvedValueOnce({ sent: true });

        await resendMfaLoginEmail('challenge');

        expect(apiRequest).toHaveBeenCalledWith('/auth/login/mfa/email', {
            method: 'POST',
            retryAuth: false,
            body: { challengeToken: 'challenge' },
        });
    });

    it('adds the second factor only when retrying an MFA-protected password reset', async () => {
        apiRequest.mockResolvedValueOnce({ reset: true });
        await resetPassword({
            email: 'test@example.com',
            code: '123456',
            newPassword: 'Password2!',
            secondFactorCode: 'A1B2C3D4-ABCD-2345-ABCD-2345',
        });

        expect(apiRequest).toHaveBeenCalledWith('/auth/password/reset', {
            method: 'POST',
            auth: false,
            retryAuth: false,
            body: {
                email: 'test@example.com',
                code: '123456',
                newPassword: 'Password2!',
                secondFactorCode: 'A1B2C3D4-ABCD-2345-ABCD-2345',
            },
        });
    });
});
