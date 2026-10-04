import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('session bootstrap interruption', () => {
    const values = new Map<string, string>();
    beforeEach(() => {
        vi.resetModules();
        values.clear();
        vi.stubGlobal('sessionStorage', {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => { values.set(key, value); },
            removeItem: (key: string) => { values.delete(key); },
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it.each([
        ['guest', 429], ['guest', 500], ['account', 429], ['account', 500],
        ['guest', 'network'], ['account', 'network'],
    ] as const)('preserves %s credentials after %s and exposes the original error', async (kind, failure) => {
        if (kind === 'guest') values.set('switch-guest-refresh', 'existing-refresh');
        const fetch = vi.fn(async (url: string) => {
            if (url.endsWith('/auth/guest')) return new Response(JSON.stringify({ accessToken: 'replacement', refreshToken: 'replacement', guest: { nickname: 'replacement' } }));
            if (failure === 'network') throw new TypeError('network unavailable');
            return new Response('{}', { status: failure });
        });
        vi.stubGlobal('fetch', fetch);
        const http = await import('./http.ts');
        const listener = vi.fn();
        http.setApiIdentity({ accessToken: 'existing', kind, nickname: 'existing-name' });
        http.setApiAccessTokenListener(listener);
        if (failure === 'network') await expect(http.bootstrapApiIdentity()).rejects.toThrow('network unavailable');
        else await expect(http.bootstrapApiIdentity()).rejects.toMatchObject({ status: failure });
        expect(listener).not.toHaveBeenCalled();
        expect(fetch.mock.calls.some(([url]) => url.endsWith('/auth/guest'))).toBe(false);
        if (kind === 'guest') expect(values.get('switch-guest-refresh')).toBe('existing-refresh');
    });

    it('does not disguise an active-room network failure as expired guest credentials', async () => {
        values.set('switch-guest-refresh', 'existing-refresh');
        values.set('switch-active-room', 'room');
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network unavailable'); }));
        const http = await import('./http.ts');
        await expect(http.bootstrapApiIdentity()).rejects.toThrow('network unavailable');
        expect(values.get('switch-guest-refresh')).toBe('existing-refresh');
    });
});
