import { beforeEach, describe, expect, it, vi } from 'vitest';

const { completeMfaLogin, loginUser, logoutAndCreateGuest } = vi.hoisted(() => ({
    completeMfaLogin: vi.fn(),
    loginUser: vi.fn(),
    logoutAndCreateGuest: vi.fn(),
}));

vi.mock('../api/auth.ts', () => ({ completeMfaLogin, loginUser }));
vi.mock('../api/http.ts', () => ({
    bootstrapApiIdentity: vi.fn(),
    logoutAndCreateGuest,
    setApiAccessTokenListener: vi.fn(),
}));

import { useAuthStore } from './useAuthStore.ts';

const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
    return { promise, resolve, reject };
};

describe('auth action progress', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('sessionStorage', { getItem: vi.fn(() => null) });
        useAuthStore.setState({
            accessToken: 'old-token', nickname: 'Alice', identity: 'account', status: 'account', bootstrapped: true, pending: false,
        });
    });

    it('keeps the boot status stable while login is pending', async () => {
        const request = deferred<{ mfaRequired: false; accessToken: string; nickname: string }>();
        loginUser.mockReturnValueOnce(request.promise);
        const action = useAuthStore.getState().login('alice@example.com', 'Password1');

        expect(useAuthStore.getState()).toMatchObject({ status: 'account', bootstrapped: true, pending: true });
        request.resolve({ mfaRequired: false, accessToken: 'new-token', nickname: 'Alice' });
        await action;
        expect(useAuthStore.getState()).toMatchObject({ status: 'account', pending: false, accessToken: 'new-token' });
    });

    it('restores the previous identity after login fails', async () => {
        loginUser.mockRejectedValueOnce(new Error('bad credentials'));
        await expect(useAuthStore.getState().login('alice@example.com', 'Password1')).rejects.toThrow('bad credentials');

        expect(useAuthStore.getState()).toMatchObject({
            accessToken: 'old-token', nickname: 'Alice', identity: 'account', status: 'account', bootstrapped: true, pending: false,
        });
    });

    it('sends the login request even when a stale active-room key remains', async () => {
        vi.stubGlobal('sessionStorage', { getItem: vi.fn((key: string) => key === 'switch-active-room' ? 'stale-room' : null) });
        loginUser.mockResolvedValueOnce({ mfaRequired: false, accessToken: 'new-token', nickname: 'Alice' });

        await useAuthStore.getState().login('alice@example.com', 'Password1');

        expect(loginUser).toHaveBeenCalledWith('alice@example.com', 'Password1');
    });

    it('keeps the challenge transient and completes it with the explicit trust choice', async () => {
        loginUser.mockResolvedValueOnce({
            mfaRequired: true,
            challengeToken: 'challenge',
            method: 'totp',
            expiresIn: 300,
        });
        completeMfaLogin.mockResolvedValueOnce({
            mfaRequired: false,
            accessToken: 'verified-token',
            nickname: 'Alice',
        });

        const challenge = await useAuthStore.getState().login('alice@example.com', 'Password1');
        expect(challenge).toMatchObject({ challengeToken: 'challenge', method: 'totp' });
        expect(useAuthStore.getState()).toMatchObject({ accessToken: 'old-token', pending: false });

        await useAuthStore.getState().completeMfa('challenge', 'A1B2C3D4-ABCD-2345-ABCD-2345', false);

        expect(completeMfaLogin).toHaveBeenCalledWith('challenge', 'A1B2C3D4-ABCD-2345-ABCD-2345', false);
        expect(useAuthStore.getState()).toMatchObject({ accessToken: 'verified-token', identity: 'account', pending: false });
    });

    it('keeps the boot status stable while logout is pending', async () => {
        const request = deferred<{ accessToken: string; nickname: string }>();
        logoutAndCreateGuest.mockReturnValueOnce(request.promise);
        const action = useAuthStore.getState().logout();

        expect(useAuthStore.getState()).toMatchObject({ status: 'account', bootstrapped: true, pending: true });
        request.resolve({ accessToken: 'guest-token', nickname: 'Guest_ABC123' });
        await action;
        expect(useAuthStore.getState()).toMatchObject({ status: 'guest', pending: false, accessToken: 'guest-token' });
    });
});
