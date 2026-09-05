import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readReplayFileWithinLimit, type ReplayFileIo } from './cli';

test('오프라인 CLI는 상한을 넘는 파일을 읽기 전에 stat 결과로 거부한다', async () => {
    let reads = 0;
    const io: ReplayFileIo = {
        stat: async () => ({ size: 65 }),
        readFile: async () => {
            reads += 1;
            return new Uint8Array(65);
        },
    };

    await assert.rejects(readReplayFileWithinLimit('bomb.swrp', 64, io), /size limit: 65 > 64/);
    assert.equal(reads, 0, '상한 검사 전에 파일 내용을 읽었다');
});
