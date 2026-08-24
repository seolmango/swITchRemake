import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FRAMES_PER_CHUNK, parseReplayContainer, REPLAY_FORMAT_VERSION } from './format';
import { MemoryReplayRecorder, NullReplayRecorder, type ReplayRecorder } from './recorder';
import type { ReplayStore } from './replay-store';

function fakeStore(): { store: ReplayStore; puts: { key: string; body: Uint8Array }[] } {
    const puts: { key: string; body: Uint8Array }[] = [];
    const store: ReplayStore = {
        put: async (key, body) => {
            puts.push({ key, body });
        },
        get: async () => {
            throw new Error('not used in this test');
        },
        delete: async () => undefined,
    };
    return { store, puts };
}

const META = {
    matchId: 'match-1',
    mapId: 'BattleField',
    snapshotHz: 30,
    startTick: 0,
    buildId: 'test-build',
    protocolVersion: 2,
    rulesVersion: 'rules-1',
    mapBundleHash: 'deadbeef',
    visibilityCoreVersion: 1,
    participants: [{ playerId: 1, nickname: 'P1', colorIndex: 0, guest: false }],
};

function frameBytes(tick: number): Uint8Array {
    return new Uint8Array([tick & 0xff, (tick >> 8) & 0xff]);
}

test('NullReplayRecorder는 아무것도 하지 않고 항상 null을 돌려준다', async () => {
    const recorder: ReplayRecorder = new NullReplayRecorder();
    recorder.begin(META);
    recorder.writeFrame(2, frameBytes(2), true);
    const handle = await recorder.finish({ endTick: 2 });
    assert.equal(handle, null);
});

test('경기 하나를 기록하면 저장소에 한 번 쓰고 handle을 돌려준다', async () => {
    const { store, puts } = fakeStore();
    const recorder = new MemoryReplayRecorder({ store });
    recorder.begin(META);

    for (let i = 0; i < FRAMES_PER_CHUNK + 5; i++) {
        const tick = (i + 1) * 2;
        const full = i % FRAMES_PER_CHUNK === 0;
        recorder.writeFrame(tick, frameBytes(tick), full);
        recorder.writeVisibility(tick, new Uint8Array(8));
    }
    recorder.writeEvent(4, { kind: 'tagged', playerId: 1, by: 2 });

    const handle = await recorder.finish({ endTick: (FRAMES_PER_CHUNK + 5) * 2 });
    assert.ok(handle, 'handle이 만들어져야 한다');
    assert.equal(handle!.formatVersion, REPLAY_FORMAT_VERSION);
    assert.equal(handle!.storageKey, 'match-1.swrp');
    assert.equal(handle!.chunkCount, 2, '61번째 프레임이 full이라 chunk가 두 개로 갈려야 한다');
    assert.equal(puts.length, 1);

    const { manifest } = parseReplayContainer(puts[0]!.body);
    assert.equal(manifest.matchId, 'match-1');
    assert.equal(manifest.chunkCount, 2);
    assert.equal(manifest.participants.length, 1);
});

test('빈 경기(프레임 없음)는 저장하지 않고 null을 돌려준다', async () => {
    const { store, puts } = fakeStore();
    const recorder = new MemoryReplayRecorder({ store });
    recorder.begin(META);
    const handle = await recorder.finish({ endTick: 0 });
    assert.equal(handle, null);
    assert.equal(puts.length, 0);
});

test('abort 후에는 기록도 finish도 무시된다', async () => {
    const { store, puts } = fakeStore();
    const recorder = new MemoryReplayRecorder({ store });
    recorder.begin(META);
    recorder.writeFrame(2, frameBytes(2), true);
    recorder.abort('test-reason');
    recorder.writeFrame(4, frameBytes(4), false);

    const handle = await recorder.finish({ endTick: 4 });
    assert.equal(handle, null);
    assert.equal(puts.length, 0);
});

test('저장소 쓰기가 실패해도 예외를 던지지 않고 null을 돌려준다', async () => {
    const store: ReplayStore = {
        put: async () => {
            throw new Error('disk full');
        },
        get: async () => {
            throw new Error('not used');
        },
        delete: async () => undefined,
    };
    const recorder = new MemoryReplayRecorder({ store });
    recorder.begin(META);
    recorder.writeFrame(2, frameBytes(2), true);

    const handle = await recorder.finish({ endTick: 2 });
    assert.equal(handle, null, '경기가 리플레이보다 우선한다 — 저장 실패가 결과 생성을 막으면 안 된다');
});
