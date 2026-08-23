import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ConnectionManager } from './connection-manager';

it('limits unauthenticated sockets per IP and frees every counter on close', () => {
    const manager = new ConnectionManager({ maxConnections: 3, maxUnauthenticatedPerIp: 2 });
    const one = manager.open('1.2.3.4')!;
    const two = manager.open('1.2.3.4')!;
    assert.equal(manager.open('1.2.3.4'), null);
    assert.equal(manager.authenticate(one.id, 9), true);
    assert.notEqual(manager.open('1.2.3.4'), null);
    assert.equal(manager.authenticate(two.id, 9), false);
    manager.close(one.id);
    assert.equal(manager.isUserConnected(9), false);
});
