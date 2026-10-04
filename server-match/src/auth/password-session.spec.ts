import assert from 'node:assert/strict';
import test from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SessionSecurityService } from '../session/session-security.service';
import { JwtAuthGuard } from './jwt-auth.guard';

const sessionId = '11111111-1111-4111-8111-111111111111';
const user = { id: 7, email: 'player@example.invalid', nickname: 'Player', securityEpoch: 3 };
const jwt = new JwtService();
const security = { hashRefreshToken: SessionSecurityService.prototype.hashRefreshToken };
const config = { get: (key: string) => key === 'JWT_ACCESS_EXPIRATION' ? 900 : key === 'JWT_REFRESH_EXPIRATION' ? 3600 : key };

function harness(active = true) {
    const session = { userId: user.id, id: sessionId, familyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation: 4, expiresAt: new Date(Date.now() + 60_000) };
    let written: Record<string, unknown> | undefined;
    const tx = {
        select: () => ({ from: () => ({ where: () => ({ for: async () => active ? [session] : [] }) }) }),
        update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => { written = values; } }) }),
    };
    const service = new AuthService({} as never, {} as never, {} as never, jwt, config as never, security as never, {} as never, {} as never, {} as never);
    return { service, tx, session, written: () => written };
}

test('password change re-signs both tokens for the retained session and new security epoch', async () => {
    const { service, tx, session, written } = harness();
    const result = await service.renewPasswordSession(tx as never, user, sessionId);
    const access = jwt.verify(result.accessToken, { secret: 'JWT_ACCESS_SECRET' });
    const refresh = jwt.verify(result.refreshToken, { secret: 'JWT_REFRESH_SECRET' });
    assert.equal(access.sid, sessionId);
    assert.equal(refresh.sid, sessionId);
    assert.equal(access.sev, 3);
    assert.equal(refresh.sev, 3);
    assert.equal(refresh.fid, session.familyId);
    assert.equal(refresh.gen, 5);
    assert.equal(written()?.refreshTokenHash, security.hashRefreshToken(result.refreshToken));
    assert.equal(written()?.generation, 5);
    assert.equal(result.nickname, user.nickname);
    const db = { select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => [{ status: 'ACTIVE', securityEpoch: user.securityEpoch }] }) }) }) };
    const guard = new JwtAuthGuard(jwt, config as never, {} as never, db as never);
    const request = { headers: { authorization: `Bearer ${result.accessToken}` } };
    const context = { switchToHttp: () => ({ getRequest: () => request }) };
    assert.equal(await guard.canActivate(context as never), true, 'the renewed token must authorize the next authenticated request');
    request.headers.authorization = `Bearer ${jwt.sign({ ...access, sev: 2 }, { secret: 'JWT_ACCESS_SECRET' })}`;
    await assert.rejects(guard.canActivate(context as never), UnauthorizedException, 'the old epoch must stay revoked');
});

test('a revoked retained session cannot receive replacement password-change tokens', async () => {
    const { service, tx, written } = harness(false);
    await assert.rejects(service.renewPasswordSession(tx as never, user, sessionId), UnauthorizedException);
    assert.equal(written(), undefined);
});
