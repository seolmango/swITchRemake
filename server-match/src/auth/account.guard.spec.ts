import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { AccountGuard } from './account.guard';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserController } from '../user/user.controller';

const context = (user: unknown) => ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) });

test('account-only guard rejects a guest before account services are called', () => {
    const guard = new AccountGuard();
    assert.throws(() => guard.canActivate(context({
        id: 'g:11111111-1111-4111-8111-111111111111',
        sessionId: '22222222-2222-4222-8222-222222222222',
        guest: true,
    }) as never), ForbiddenException);
});

test('account-only guard accepts a numeric account with a v4 session id', () => {
    const guard = new AccountGuard();
    assert.equal(guard.canActivate(context({
        id: 42,
        sessionId: '22222222-2222-4222-8222-222222222222',
        guest: false,
    }) as never), true);
});

test('personal stats and match history routes both require the account guard', () => {
    for (const handler of [UserController.prototype.getMyStats, UserController.prototype.getMyMatches]) {
        const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined;
        assert.ok(guards?.includes(AccountGuard));
    }
});
