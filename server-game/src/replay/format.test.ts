import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    buildReplayContainer,
    decodeChunk,
    FRAMES_PER_CHUNK,
    parseReplayContainer,
    REPLAY_FORMAT_VERSION,
    ReplayDecodeError,
    verifyRootHash,
    type ChunkAccumulator,
    type ReplayManifest,
} from './format';

function bytesOf(n: number): Uint8Array {
    // 매 프레임이 다르게 생기게 만든다. 전부 같으면 순서 버그를 못 잡는다.
    return new Uint8Array([n & 0xff, (n >> 8) & 0xff, 1, 2, 3]);
}

function makeChunk(startTick: number, frameCount: number, withEvent: boolean): ChunkAccumulator {
    const frames = Array.from({ length: frameCount }, (_, i) => ({
        tick: startTick + i * 2,
        full: i === 0,
        bytes: bytesOf(startTick + i),
    }));
    const visibilities = frames.map((f) => ({ tick: f.tick, masks: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }));
    const events = withEvent
        ? [{ tick: startTick + 1, event: { kind: 'tagged' as const, playerId: 0, by: 1 } }]
        : [];
    return { frames, visibilities, events };
}

const MANIFEST_BASE: Omit<ReplayManifest, 'chunkCount' | 'rootHash'> = {
    replayFormatVersion: REPLAY_FORMAT_VERSION,
    matchId: 'match-format-test',
    mapId: 'BattleField',
    snapshotHz: 30,
    startTick: 2,
    endTick: 400,
    durationTicks: 398,
    buildId: 'test-build',
    protocolVersion: 2,
    rulesVersion: 'rules-1',
    mapBundleHash: 'deadbeef',
    visibilityCoreVersion: 1,
    participants: [
        { playerId: 0, nickname: 'P0', colorIndex: 0, guest: false },
        { playerId: 1, nickname: 'P1', colorIndex: 1, guest: true },
    ],
};

test('컨테이너를 만들고 파싱하면 manifest가 그대로 돌아온다', () => {
    const chunks = [makeChunk(2, FRAMES_PER_CHUNK, true), makeChunk(122, 10, false)];
    const container = buildReplayContainer(MANIFEST_BASE, chunks);

    const { manifest, chunkIndex } = parseReplayContainer(container.bytes);
    assert.equal(manifest.matchId, 'match-format-test');
    assert.equal(manifest.chunkCount, 2);
    assert.equal(manifest.rootHash, container.rootHash);
    assert.equal(chunkIndex.length, 2);
    assert.ok(verifyRootHash(manifest, chunkIndex), 'rootHash가 chunk 해시 목록과 일치해야 한다');
});

test('chunk를 디코드하면 프레임·시야·이벤트가 순서대로 복원된다', () => {
    const chunks = [makeChunk(2, 3, true)];
    const container = buildReplayContainer(MANIFEST_BASE, chunks);
    const { chunkIndex } = parseReplayContainer(container.bytes);

    const decoded = decodeChunk(container.bytes, chunkIndex[0]!);
    assert.equal(decoded.frames.length, 3);
    assert.deepEqual(decoded.frames.map((f) => f.tick), [2, 4, 6]);
    assert.equal(decoded.frames[0]!.full, true);
    assert.equal(decoded.frames[1]!.full, false);
    assert.deepEqual([...decoded.frames[2]!.bytes], [...bytesOf(2 + 2)]);

    assert.equal(decoded.visibilities.length, 3);
    assert.equal(decoded.events.length, 1);
    assert.deepEqual(decoded.events[0]!.event, { kind: 'tagged', playerId: 0, by: 1 });
});

test('chunk 해시가 어긋나면 손상으로 거부한다', () => {
    const chunks = [makeChunk(2, 2, false)];
    const container = buildReplayContainer(MANIFEST_BASE, chunks);
    const { chunkIndex } = parseReplayContainer(container.bytes);
    const tampered = new Uint8Array(container.bytes);
    // 압축된 chunk 영역 한 바이트를 뒤집는다. 해시 검증이 없으면 조용히 잘못된 프레임을 읽는다.
    tampered[chunkIndex[0]!.offset] = tampered[chunkIndex[0]!.offset]! ^ 0xff;

    assert.throws(() => decodeChunk(tampered, chunkIndex[0]!), ReplayDecodeError);
});

test('bad magic은 즉시 거부한다', () => {
    const chunks = [makeChunk(2, 1, false)];
    const container = buildReplayContainer(MANIFEST_BASE, chunks);
    const corrupted = new Uint8Array(container.bytes);
    corrupted[0] = 0;
    assert.throws(() => parseReplayContainer(corrupted), ReplayDecodeError);
});

test('chunk가 하나도 없으면 컨테이너를 만들지 않는다', () => {
    assert.throws(() => buildReplayContainer(MANIFEST_BASE, []));
});
