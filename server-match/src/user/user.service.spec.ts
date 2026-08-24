import assert from 'node:assert/strict';
import test from 'node:test';
import * as bcrypt from 'bcrypt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { UserService } from './user.service';

function createService(passwordHash: string) {
    const writes: { passwordHash: string }[] = [];
    const sessions: {
        assertOwnedActiveSession: (userId: number, currentSessionId: string) => Promise<void>;
        revokeOthers: (userId: number, currentSessionId: string) => Promise<number>;
    } = {
        assertOwnedActiveSession: async () => undefined,
        revokeOthers: async () => 2,
    };
    const db = {
        select: () => ({ from: () => ({ where: async () => [{ passwordHash }] }) }),
        update: () => ({ set: (value: { passwordHash: string }) => {
            writes.push(value);
            return { where: async () => [] };
        } }),
    };
    const service = new UserService(db as never, {} as never, {} as never, sessions as never);
    return { service, writes, sessions };
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
    const { service, writes, sessions } = createService(await bcrypt.hash('Correct1', 4));
    let revokeArguments: [number, string] | undefined;
    sessions.revokeOthers = async (userId: number, currentSessionId: string) => {
        revokeArguments = [userId, currentSessionId];
        assert.equal(userId, 1);
        assert.equal(currentSessionId, sessionId);
        return 2;
    };

    const result = await service.changePassword(1, sessionId, { currentPassword: 'Correct1', newPassword: 'Different1' });
    assert.deepEqual(result, { revokedCount: 2 });
    assert.equal(writes.length, 1);
    assert.equal(await bcrypt.compare('Different1', writes[0]!.passwordHash), true);
    assert.equal(await bcrypt.compare('Correct1', writes[0]!.passwordHash), false);
    assert.deepEqual(revokeArguments, [1, sessionId]);
});
