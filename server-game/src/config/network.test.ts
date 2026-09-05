import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NETWORK } from './network';

test('재접속 자리는 5초만 보존하고 결과창은 10초 뒤 대기실로 돌아간다', () => {
    assert.equal(NETWORK.RECONNECT_GRACE_MS, 5_000);
    assert.equal(NETWORK.POST_GAME_MS, 10_000);
});
