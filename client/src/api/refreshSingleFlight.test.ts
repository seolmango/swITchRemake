import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * refresh 토큰은 한 번 쓰면 회전하고, 서버는 이미 쓴 토큰이 다시 오면 재사용 공격으로 보고
 * **그 계정의 세션을 전부 끊는다**. 그래서 같은 쿠키로 두 번 동시에 부르면 정상 사용자가
 * 로그아웃된다 — 실제로 그랬다(브라우저 자동 점검이 잡았다).
 *
 * 여기서 지키는 것은 하나다: 동시에 여러 경로가 재발급을 원해도 **네트워크 요청은 한 번**.
 */
describe('토큰 재발급 단일 비행', () => {
    const calls: string[] = [];

    beforeEach(() => {
        vi.resetModules();
        calls.length = 0;
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            calls.push(String(url));
            return new Response(JSON.stringify({ accessToken: 'a', nickname: 'n' }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        }));
        vi.stubGlobal('sessionStorage', {
            store: new Map<string, string>(),
            getItem(key: string) { return this.store.get(key) ?? null; },
            setItem(key: string, value: string) { this.store.set(key, value); },
            removeItem(key: string) { this.store.delete(key); },
        });
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    it('부팅과 401 재시도가 겹쳐도 /auth/refresh는 한 번만 나간다', async () => {
        const http = await import('./http.ts');
        // 계정 신원으로 만들어 둔다. 그래야 401 재시도가 계정 경로를 탄다.
        http.setApiAccessToken('stale-token', 'nick');

        // 부팅과 세션 확인이 동시에 재발급을 원하는 상황.
        const [first, second] = await Promise.all([
            http.tryRefreshSession(),
            http.tryRefreshSession(),
        ]);

        expect(first).toBe('a');
        expect(second).toBe('a');
        const refreshCalls = calls.filter((url) => url.endsWith('/auth/refresh'));
        expect(refreshCalls).toHaveLength(1);
    });

    it('한 번 끝난 뒤에는 다시 부를 수 있다', async () => {
        const http = await import('./http.ts');
        http.setApiAccessToken('stale-token', 'nick');

        await http.tryRefreshSession();
        await http.tryRefreshSession();

        // 회전 자체를 막는 것이 아니라 **동시 중복**만 막는다.
        expect(calls.filter((url) => url.endsWith('/auth/refresh'))).toHaveLength(2);
    });

    it('MFA 업무 오류는 토큰 만료로 오해해 재시도하지 않는다', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            calls.push(String(url));
            return new Response(JSON.stringify({ code: 'INVALID_SECOND_FACTOR' }), {
                status: 401, headers: { 'content-type': 'application/json' },
            });
        }));
        const http = await import('./http.ts');
        http.setApiAccessToken('valid-token', 'nick');

        await expect(http.apiRequest('/users/me/mfa', { method: 'DELETE', body: { code: 'bad' } }))
            .rejects.toMatchObject({ code: 'INVALID_SECOND_FACTOR' });

        expect(calls.filter((url) => url.endsWith('/auth/refresh'))).toHaveLength(0);
        expect(calls.filter((url) => url.endsWith('/users/me/mfa'))).toHaveLength(1);
    });
});
