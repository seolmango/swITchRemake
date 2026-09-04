import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ConnectionManager } from './connection-manager';

it('limits unauthenticated sockets per IP and frees every counter on close', () => {
    const manager = new ConnectionManager({ maxConnections: 3, maxUnauthenticatedPerIp: 2, maxAuthenticatedPerIp: 2 });
    const one = manager.open('1.2.3.4')!;
    const two = manager.open('1.2.3.4')!;
    assert.equal(manager.open('1.2.3.4'), null);
    assert.equal(manager.authenticate(one.id, 9), true);
    assert.notEqual(manager.open('1.2.3.4'), null);
    assert.equal(manager.authenticate(two.id, 9), false);
    manager.close(one.id);
    assert.equal(manager.isUserConnected(9), false);
});

it('인증을 끝낸 뒤에도 IP별 연결 상한을 유지하고 종료하면 자리를 돌려준다', () => {
    const manager = new ConnectionManager({ maxConnections: 10, maxUnauthenticatedPerIp: 5, maxAuthenticatedPerIp: 2 });
    const one = manager.open('1.2.3.4')!;
    const two = manager.open('1.2.3.4')!;
    const three = manager.open('1.2.3.4')!;

    assert.equal(manager.authenticate(one.id, 1), true);
    assert.equal(manager.authenticate(two.id, 2), true);
    assert.equal(manager.authenticate(three.id, 3), false, '게스트 id를 바꿔도 같은 IP의 세 번째 인증은 막는다');
    assert.equal(manager.authenticatedCount('1.2.3.4'), 2);

    manager.close(one.id);
    assert.equal(manager.authenticate(three.id, 3), true);
    assert.equal(manager.authenticatedCount('1.2.3.4'), 2);
});
