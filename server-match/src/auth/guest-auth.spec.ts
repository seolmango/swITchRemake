import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

test('guest issuance creates a tab-scoped refresh session and never creates an account session', async () => {
    const signedPayloads: Record<string, unknown>[] = [];
    let sessionWrites = 0;
    let guestSession: string | undefined;
    const redis = {
        incrementWithTtl: async () => 1,
        ttlMilliseconds: async () => 60_000,
        set: async (_key: string, value: string) => { guestSession = value; },
    };
    const jwt = { sign: (payload: Record<string, unknown>) => { signedPayloads.push(payload); return `token-${signedPayloads.length}`; } };
    const config = { get: (key: string) => key.includes('EXPIRATION') ? (key.includes('REFRESH') ? 3600 : 900) : 'secret' };
    const sessions = { create: async () => { sessionWrites++; } };
    const security = { hmacIp: () => 'ip-hmac' };
    const service = new AuthService(
        {} as never, redis as never, {} as never, jwt as never, config as never,
        security as never, sessions as never, {} as never,
    );

    const issued = await service.createGuest('203.0.113.4');
    assert.match(issued.guest.id, /^g:[0-9a-f-]{36}$/);
    assert.match(issued.guest.nickname, /^Guest_[A-HJ-NP-Z2-9]{6}$/);
    assert.deepEqual(signedPayloads[0], {
        sub: issued.guest.id,
        nickname: issued.guest.nickname,
        guest: true,
        sid: signedPayloads[0].sid,
        type: 'guest-access',
    });
    assert.equal(signedPayloads[1].type, 'guest-refresh');
    assert.equal(JSON.parse(guestSession!).id, issued.guest.id);
    assert.equal(issued.refreshToken, 'token-2');
    assert.equal(sessionWrites, 0);
});

test('guest issuance rate is enforced by request IP', async () => {
    const redis = { incrementWithTtl: async () => 6, ttlMilliseconds: async () => 12_000 };
    const service = new AuthService(
        {} as never, redis as never, {} as never, {} as never,
        { get: () => 'secret' } as never, { hmacIp: () => 'ip-hmac' } as never, {} as never, {} as never,
    );
    await assert.rejects(service.createGuest('203.0.113.4'), (error: unknown) => {
        assert.ok(error instanceof HttpException);
        assert.equal(error.getStatus(), 429);
        return true;
    });
});

test('JWT guard accepts a signed guest actor without requiring a session id', async () => {
    const payload = {
        sub: 'g:11111111-1111-4111-8111-111111111111',
        nickname: 'Guest_7KPW2M',
        guest: true,
        sid: '22222222-2222-4222-8222-222222222222',
        type: 'guest-access',
    };
    const request: Record<string, any> = { headers: { authorization: 'Bearer token' } };
    const guard = new JwtAuthGuard(
        { verify: () => payload } as never,
        { get: () => 'secret' } as never,
        { get: async () => '{"active":true}' } as never,
    );
    const context = { switchToHttp: () => ({ getRequest: () => request }) };
    assert.equal(await guard.canActivate(context as never), true);
    assert.deepEqual(request.user, { id: payload.sub, nickname: payload.nickname, sessionId: payload.sid, guest: true });
});

test('guest refresh rotates once and rejects replay of the previous token', async () => {
    const payload = {
        sub: 'g:11111111-1111-4111-8111-111111111111',
        sid: '22222222-2222-4222-8222-222222222222',
        jti: '33333333-3333-4333-8333-333333333333',
        type: 'guest-refresh',
    } as const;
    const raw = JSON.stringify({ id: payload.sub, nickname: 'Guest_7KPW2M', jti: payload.jti });
    let rotations = 0;
    const redis = {
        get: async () => raw,
        compareAndSetWithTtl: async () => ++rotations === 1,
    };
    const jwt = {
        verify: () => payload,
        sign: (_body: unknown, options: { secret: string }) => options.secret.includes('guest') ? 'next-refresh' : 'next-access',
    };
    const config = { get: (key: string) => key.includes('EXPIRATION') ? 900 : key === 'JWT_GUEST_REFRESH_SECRET' ? 'guest-secret' : 'access-secret' };
    const service = new AuthService(
        {} as never, redis as never, {} as never, jwt as never, config as never,
        {} as never, {} as never, {} as never,
    );

    const next = await service.refreshGuest('old-refresh');
    assert.equal(next.refreshToken, 'next-refresh');
    await assert.rejects(service.refreshGuest('old-refresh'), /already used/);
});
