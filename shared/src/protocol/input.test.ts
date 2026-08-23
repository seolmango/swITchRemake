import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    INPUT_PACKET_BYTES,
    InputDecodeError,
    compareSequence,
    decodeInput,
    encodeInput,
    isNewerSequence,
    movementVector,
    nextSequence,
    type InputState,
} from './input';

const base: InputState = {
    sequence: 0, left: false, right: false, up: false, down: false, heldActions: 0,
};

test('입력 패킷 라운드트립', () => {
    const state: InputState = { sequence: 4321, left: true, right: false, up: false, down: true, heldActions: 0b101 };
    const decoded = decodeInput(encodeInput(state));
    assert.deepEqual(decoded, state);
});

test('입력 패킷은 정확히 6바이트다', () => {
    assert.equal(encodeInput(base).byteLength, INPUT_PACKET_BYTES);
});

test('길이가 다른 패킷을 버린다', () => {
    // 남는 바이트를 관대하게 무시하면 그게 곧 파서 공격면이 된다.
    assert.throws(() => decodeInput(new ArrayBuffer(INPUT_PACKET_BYTES - 1)), InputDecodeError);
    assert.throws(() => decodeInput(new ArrayBuffer(INPUT_PACKET_BYTES + 1)), InputDecodeError);
});

test('프로토콜 버전이 다르면 거부한다', () => {
    const buf = encodeInput(base);
    new DataView(buf).setUint8(0, 99);
    assert.throws(() => decodeInput(buf), InputDecodeError);
});

test('좌우 동시 입력은 축을 0으로 만든다', () => {
    const v = movementVector({ ...base, left: true, right: true });
    assert.equal(v.x, 0);
    assert.equal(v.y, 0);
});

test('대각선 이동은 정규화된다', () => {
    const v = movementVector({ ...base, right: true, down: true });
    assert.ok(Math.abs(Math.hypot(v.x, v.y) - 1) < 1e-9, '대각선이 더 빠르면 안 된다');
});

test('sequence 비교가 wrap을 넘긴다', () => {
    // 단순 크기 비교였다면 여기서 모든 입력이 과거로 판정돼 버려졌다.
    assert.ok(isNewerSequence(0, 65535), '65535 다음 0은 미래다');
    assert.ok(isNewerSequence(5, 65530));
    assert.ok(!isNewerSequence(65535, 0));
    assert.ok(!isNewerSequence(10, 10), '같은 sequence는 중복이므로 미래가 아니다');
    assert.ok(isNewerSequence(11, 10));
    assert.equal(compareSequence(10, 10), 0);
    assert.ok(compareSequence(0, 65535) > 0);
    assert.ok(compareSequence(65535, 0) < 0);
});

test('nextSequence가 u16을 넘어가면 0으로 돈다', () => {
    assert.equal(nextSequence(65535), 0);
    assert.equal(nextSequence(0), 1);
});

test('한 바퀴 전부 돌려도 항상 다음이 미래로 판정된다', () => {
    let seq = 0;
    for (let i = 0; i < 65536 + 10; i++) {
        const next = nextSequence(seq);
        assert.ok(isNewerSequence(next, seq), `wrap 지점에서 실패: ${seq} -> ${next}`);
        seq = next;
    }
});
