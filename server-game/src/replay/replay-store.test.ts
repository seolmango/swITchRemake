import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { LocalReplayStore, ReplayStoreKeyError } from './replay-store';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'switch-replay-test-'));
    try {
        return await fn(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test('put한 뒤 get으로 그대로 읽힌다', async () => {
    await withTempDir(async (dir) => {
        const store = new LocalReplayStore(dir);
        const body = new Uint8Array([1, 2, 3, 4, 5]);
        await store.put('match-1.swrp', body);
        const read = await store.get('match-1.swrp');
        assert.deepEqual([...read], [...body]);
    });
});

test('range를 주면 그 구간만 읽는다', async () => {
    await withTempDir(async (dir) => {
        const store = new LocalReplayStore(dir);
        await store.put('match-1.swrp', new Uint8Array([10, 20, 30, 40, 50]));
        const read = await store.get('match-1.swrp', { start: 1, end: 3 });
        assert.deepEqual([...read], [20, 30]);
    });
});

test('delete 후에는 읽을 수 없다', async () => {
    await withTempDir(async (dir) => {
        const store = new LocalReplayStore(dir);
        await store.put('match-1.swrp', new Uint8Array([1]));
        await store.delete('match-1.swrp');
        await assert.rejects(() => store.get('match-1.swrp'));
    });
});

test('존재하지 않는 키를 지워도 에러가 나지 않는다', async () => {
    await withTempDir(async (dir) => {
        const store = new LocalReplayStore(dir);
        await store.delete('never-existed.swrp');
    });
});

test('경로 조작이 들어간 key는 거부한다', async () => {
    await withTempDir(async (dir) => {
        const store = new LocalReplayStore(dir);
        await assert.rejects(() => store.put('../escape.swrp', new Uint8Array([1])), ReplayStoreKeyError);
        await assert.rejects(() => store.get('..%2f..%2fetc-passwd.swrp'), ReplayStoreKeyError);
    });
});
