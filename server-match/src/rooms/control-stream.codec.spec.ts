import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL_VERSION, ControlErrorCode, type ControlCommand, type ControlReply } from 'shared';
import { CONTROL_STREAM_FIELDS, decodeReply, encodeCommand } from './control-stream.codec';

test('control stream codec uses one stable JSON field per direction', () => {
    const command: ControlCommand = {
        v: CONTROL_VERSION,
        requestId: '08c57a64-7cf6-435d-8b16-82f7f1871e1d',
        type: 'RESERVE_JOIN',
        issuedAt: 1,
        deadlineAt: 2,
        replyTo: 'dev:matching-server:replies:test',
        payload: { roomId: 'ROOM1', userId: 7, nickname: 'Alice', password: null },
    };
    const reply: ControlReply = {
        v: CONTROL_VERSION,
        requestId: command.requestId,
        serverId: 'game-local-p1',
        ok: false,
        code: ControlErrorCode.RoomFull,
        payload: null,
    };

    assert.equal(CONTROL_STREAM_FIELDS.command, 'command');
    assert.equal(CONTROL_STREAM_FIELDS.reply, 'reply');
    assert.deepEqual(JSON.parse(encodeCommand(command)), command);
    assert.deepEqual(decodeReply(JSON.stringify(reply)), reply);
});

test('control reply codec rejects an uncorrelatable payload', () => {
    assert.throws(() => decodeReply('{"v":1,"ok":true}'), /Malformed control reply/);
});
