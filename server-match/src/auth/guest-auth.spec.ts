import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

test('guest issuance creates a namespaced identity and never creates a session', async () => {
    let signedPayload: Record<string, unknown> | undefined;
    let sessionWrites = 0;
    const redis = {
        incrementWithTtl: async () => 1,
        ttlMilliseconds: async () => 60_000,
    };
    const jwt = { sign: (payload: Record<string, unknown>) => { signedPayload = payload; return 'guest-token'; } };
    const config = { get: (key: string) => key === 'JWT_ACCESS_EXPIRATION' ? 900 : 'secret' };
    const sessions = { create: async () => { sessionWrites++; } };
    const security = { hmacIp: () => 'ip-hmac' };
    const service = new AuthService(
        {} as never, redis as never, {} as never, jwt as never, config as never,
        security as never, sessions as never, {} as never,
    );

    const issued = await service.createGuest('203.0.113.4');
    assert.match(issued.guest.id, /^g:[0-9a-f-]{36}$/);
    assert.match(issued.guest.nickname, /^Guest_[A-HJ-NP-Z2-9]{6}$/);
    assert.deepEqual(signedPayload, {
        sub: issued.guest.id,
        nickname: issued.guest.nickname,
        guest: true,
        type: 'access',
    });
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
        type: 'access',
    };
    const request: Record<string, any> = { headers: { authorization: 'Bearer token' } };
    const guard = new JwtAuthGuard(
        { verify: () => payload } as never,
        { get: () => 'secret' } as never,
    );
    const context = { switchToHttp: () => ({ getRequest: () => request }) };
    assert.equal(await guard.canActivate(context as never), true);
    assert.deepEqual(request.user, { id: payload.sub, nickname: payload.nickname, guest: true });
});
