import assert from 'node:assert/strict';
import test from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

const payload = {
    sub: 7,
    sid: '11111111-1111-4111-8111-111111111111',
    type: 'access',
    sev: 3,
};

function harness(authority: { status: string; securityEpoch: number } | undefined) {
    const request: Record<string, any> = { headers: { authorization: 'Bearer token' } };
    const db = {
        select: () => ({
            from: () => ({ innerJoin: () => ({ where: async () => authority ? [authority] : [] }) }),
        }),
    };
    const guard = new JwtAuthGuard(
        { verify: () => payload } as never,
        { get: () => 'secret' } as never,
        {} as never,
        db as never,
    );
    const context = { switchToHttp: () => ({ getRequest: () => request }) };
    return { guard, request, context };
}

test('계정 access token은 살아 있는 세션과 같은 security epoch가 있어야 통과한다', async () => {
    const active = harness({ status: 'ACTIVE', securityEpoch: 3 });
    assert.equal(await active.guard.canActivate(active.context as never), true);
    assert.deepEqual(active.request.user, { id: 7, sessionId: payload.sid, guest: false });

    const revoked = harness(undefined);
    await assert.rejects(revoked.guard.canActivate(revoked.context as never), UnauthorizedException);

    const oldEpoch = harness({ status: 'ACTIVE', securityEpoch: 4 });
    await assert.rejects(oldEpoch.guard.canActivate(oldEpoch.context as never), UnauthorizedException);
});
