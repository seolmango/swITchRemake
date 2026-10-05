// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fetchMock = vi.fn<typeof fetch>();
const guest = { accessToken: 'synthetic-guest-access', refreshToken: 'synthetic-guest-refresh', guest: { id: 'synthetic-guest', nickname: 'Guest_Test' } };
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
async function account() {
    const http = await import('./http.ts');
    const { useAuthStore } = await import('../stores/useAuthStore.ts');
    http.setApiIdentity({ kind: 'account', accessToken: 'synthetic-account-access', nickname: 'synthetic-account' });
    useAuthStore.setState({ bootstrapped: true });
    return { http, store: useAuthStore };
}
const paths = () => fetchMock.mock.calls.map(([url]) => String(url));
beforeEach(() => { vi.resetModules(); sessionStorage.clear(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

it.each([0, 503, 429])('preserves the account and reports an unacknowledged logout (failure %i)', async status => {
    const { store } = await account();
    if (status === 0) fetchMock.mockRejectedValueOnce(new TypeError('synthetic network interruption'));
    else fetchMock.mockResolvedValueOnce(json(status));
    fetchMock.mockResolvedValue(json(201, guest));
    await expect(store.getState().logout()).rejects.toBeDefined();
    expect(store.getState()).toMatchObject({ status: 'account', identity: 'account', nickname: 'synthetic-account', pending: false });
    expect(paths()).toEqual(['/api/auth/logout']);
});

it('starts and retries guest issuance consistently when no authenticated identity exists', async () => {
    const { http, store } = await account();
    http.setApiIdentity({ kind: 'anonymous', accessToken: null, nickname: null });
    fetchMock.mockResolvedValueOnce(json(503));
    await expect(store.getState().logout()).rejects.toMatchObject({ status: 503 });
    expect(store.getState()).toMatchObject({ status: 'error', identity: 'anonymous', pending: false });
    fetchMock.mockResolvedValueOnce(json(201, guest));
    await store.getState().logout();
    expect(paths()).toEqual(['/api/auth/guest', '/api/auth/guest']);
    expect(store.getState()).toMatchObject({ status: 'guest', identity: 'guest', pending: false });
});

it('preserves a guest refresh identity when logout receives a temporary server failure', async () => {
    const { http, store } = await account();
    sessionStorage.setItem('switch-guest-refresh', guest.refreshToken);
    http.setApiIdentity({ kind: 'guest', accessToken: guest.accessToken, nickname: guest.guest.nickname });
    fetchMock.mockResolvedValueOnce(json(503)).mockResolvedValue(json(201, guest));
    await expect(store.getState().logout()).rejects.toMatchObject({ status: 503 });
    expect(store.getState()).toMatchObject({ status: 'guest', identity: 'guest', pending: false });
    expect(sessionStorage.getItem('switch-guest-refresh')).toBe(guest.refreshToken);
    expect(paths()).toEqual(['/api/auth/logout']);
});

it('refreshes an expired access token and obtains a real logout acknowledgment before issuing a guest', async () => {
    const { store } = await account();
    fetchMock.mockResolvedValueOnce(json(401))
        .mockResolvedValueOnce(json(201, { accessToken: 'synthetic-renewed-access', nickname: 'synthetic-account' }))
        .mockResolvedValueOnce(json(201, { loggedOut: true }))
        .mockResolvedValueOnce(json(201, guest));
    await store.getState().logout();
    expect(paths()).toEqual(['/api/auth/logout', '/api/auth/refresh', '/api/auth/logout', '/api/auth/guest']);
    expect(store.getState()).toMatchObject({ status: 'guest', identity: 'guest', pending: false });
});

it('allows a new guest only after refresh authoritatively rejects an already revoked account', async () => {
    const { store } = await account();
    fetchMock.mockResolvedValueOnce(json(401)).mockResolvedValueOnce(json(401)).mockResolvedValueOnce(json(201, guest));
    await store.getState().logout();
    expect(paths()).toEqual(['/api/auth/logout', '/api/auth/refresh', '/api/auth/guest']);
    expect(store.getState()).toMatchObject({ status: 'guest', identity: 'guest', pending: false });
});

it('keeps the account invalidated if logout succeeded but the new guest could not be issued', async () => {
    const { store } = await account();
    fetchMock.mockResolvedValueOnce(json(201, { loggedOut: true })).mockResolvedValueOnce(json(503));
    await expect(store.getState().logout()).rejects.toMatchObject({ status: 503 });
    expect(store.getState()).toMatchObject({ status: 'error', identity: 'anonymous', accessToken: null, pending: false });
});

it('preserves an acknowledged refresh identity when the retried logout is rejected during a room', async () => {
    const { store } = await account();
    fetchMock.mockResolvedValueOnce(json(401))
        .mockResolvedValueOnce(json(201, { accessToken: 'synthetic-renewed-access', nickname: 'synthetic-account' }))
        .mockResolvedValueOnce(json(409, { code: 'IDENTITY_SWITCH_DURING_ROOM' }));
    await expect(store.getState().logout()).rejects.toMatchObject({ status: 409 });
    expect(store.getState()).toMatchObject({ status: 'account', accessToken: 'synthetic-renewed-access', pending: false });
    expect(paths()).toEqual(['/api/auth/logout', '/api/auth/refresh', '/api/auth/logout']);
});
