/**
 * 리플레이 형식의 노드 쪽 입구.
 *
 * 형식 자체는 `shared`에 있다 — 브라우저 재생기가 같은 파일을 읽어야 하기 때문이다. 여기서는
 * 노드가 가진 gzip·sha256을 끼워 넣기만 한다.
 */

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { ReplayCodec } from 'shared';

export {
    REPLAY_MAGIC,
    REPLAY_CONTAINER_VERSION,
    REPLAY_FORMAT_VERSION,
    FRAMES_PER_CHUNK,
    ReplayDecodeError,
    buildReplayContainer,
    parseReplayContainer,
    decodeChunk,
    verifyRootHash,
    type ReplayCodec,
    type ReplayEvent,
    type RecordedFrame,
    type RecordedVisibility,
    type RecordedEvent,
    type ChunkAccumulator,
    type ReplayManifest,
    type ChunkIndexEntry,
    type ReplayContainer,
} from 'shared';

/** `node:zlib`과 `node:crypto`로 만든 코덱. 동기 API를 약속으로 감싼 것뿐이다. */
export const nodeReplayCodec: ReplayCodec = {
    async gzip(data) {
        const out = gzipSync(data);
        return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    },
    async gunzip(data) {
        const out = gunzipSync(data);
        return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    },
    async sha256(data) {
        const out = createHash('sha256').update(data).digest();
        return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    },
};
