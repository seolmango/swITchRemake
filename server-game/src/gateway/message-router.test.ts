import assert from 'node:assert/strict';
import { it } from 'node:test';
import { parseAuthMessage, parseClientMessage } from './message-router';

it('accepts only the shared auth envelope before authentication', () => {
    assert.deepEqual(parseAuthMessage('{"v":1,"type":"auth","requestId":4,"payload":{"ticket":"abc"}}'), { ticket: 'abc', requestId: 4 });
    assert.equal(parseAuthMessage('{"v":1,"type":"ping","payload":{"clientTime":1}}'), null);
});

it('validates commands at runtime and preserves requestId on rejection', () => {
    const violations: unknown[] = [];
    const context = { userId: 7, roomId: 'room', tick: 9 };
    const valid = parseClientMessage('{"v":1,"type":"ping","requestId":12,"payload":{"clientTime":3}}', context, (signal) => violations.push(signal));
    assert.equal(valid.message?.type, 'ping');
    const invalid = parseClientMessage('{"v":1,"type":"game.useSkill","requestId":13,"payload":{"slot":"x"}}', context, (signal) => violations.push(signal));
    assert.equal(invalid.message, null);
    assert.equal(invalid.requestId, 13);
    assert.equal(violations.length, 1);
});
