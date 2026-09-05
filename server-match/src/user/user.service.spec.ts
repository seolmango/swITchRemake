import assert from 'node:assert/strict';
import test from 'node:test';
import * as bcrypt from 'bcrypt';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { UserService } from './user.service';

function createService(passwordHash: string, updateSucceeds = true) {
    const writes: { passwordHash: string }[] = [];
    const transaction = { kind: 'password-change' };
    const sessions: {
        assertOwnedActiveSession: (userId: number, currentSessionId: string, tx?: unknown) => Promise<void>;
        revokeOthers: (userId: number, currentSessionId: string, tx?: unknown) => Promise<number>;
    } = {
        assertOwnedActiveSession: async () => undefined,
        revokeOthers: async () => 2,
    };
    const tx = {
        ...transaction,
        update: () => ({
            set: (value: { passwordHash: string }) => {
                writes.push(value);
                return {
                    where: () => ({
                        returning: async () => updateSucceeds ? [{ id: 1 }] : [],
                    }),
                };
            },
        }),
    };
    const db = {
        select: () => ({ from: () => ({ where: async () => [{ passwordHash }] }) }),
        transaction: async (callback: (value: unknown) => Promise<unknown>) => callback(tx),
    };
    const service = new UserService(db as never, {} as never, {} as never, sessions as never, {} as never, {} as never, {} as never);
    return { service, writes, sessions, tx };
}

const sessionId = '11111111-1111-4111-8111-111111111111';

test('password changes reject an incorrect current password with 401', async () => {
    const { service, writes } = createService(await bcrypt.hash('Correct1', 4));
    await assert.rejects(
        service.changePassword(1, sessionId, { currentPassword: 'Wrong111', newPassword: 'Different1' }),
        UnauthorizedException,
    );
    assert.equal(writes.length, 0);
});

test('password changes reject a new password equal to the current password', async () => {
    const { service, writes } = createService(await bcrypt.hash('Correct1', 4));
    await assert.rejects(
        service.changePassword(1, sessionId, { currentPassword: 'Correct1', newPassword: 'Correct1' }),
        BadRequestException,
    );
    assert.equal(writes.length, 0);
});

test('password changes update the hash and revoke other sessions', async () => {
    const { service, writes, sessions, tx } = createService(await bcrypt.hash('Correct1', 4));
    let revokeArguments: [number, string] | undefined;
    sessions.revokeOthers = async (userId: number, currentSessionId: string, receivedTx?: unknown) => {
        revokeArguments = [userId, currentSessionId];
        assert.equal(userId, 1);
        assert.equal(currentSessionId, sessionId);
        assert.equal(receivedTx, tx, 'session revocation must share the password transaction');
        return 2;
    };

    const result = await service.changePassword(1, sessionId, { currentPassword: 'Correct1', newPassword: 'Different1' });
    assert.deepEqual(result, { revokedCount: 2 });
    assert.equal(writes.length, 1);
    assert.equal(await bcrypt.compare('Different1', writes[0]!.passwordHash), true);
    assert.equal(await bcrypt.compare('Correct1', writes[0]!.passwordHash), false);
    assert.deepEqual(revokeArguments, [1, sessionId]);
});

test('동시에 비밀번호가 바뀌면 다른 세션을 폐기하지 않고 409로 재시도를 요구한다', async () => {
    const { service, sessions } = createService(await bcrypt.hash('Correct1', 4), false);
    let revokeCalled = false;
    sessions.revokeOthers = async () => {
        revokeCalled = true;
        return 0;
    };

    await assert.rejects(
        service.changePassword(1, sessionId, { currentPassword: 'Correct1', newPassword: 'Different1' }),
        ConflictException,
    );
    assert.equal(revokeCalled, false);
});
