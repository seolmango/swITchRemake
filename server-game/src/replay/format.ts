/**
 * 리플레이 형식의 노드 쪽 입구.
 *
 * 형식 자체는 `shared`에 있다 — 브라우저 재생기가 같은 파일을 읽어야 하기 때문이다. 여기서는
 * 노드가 가진 gzip·sha256을 끼워 넣기만 한다.
 */

import { createHash } from 'node:crypto';
import { createGunzip, gzipSync } from 'node:zlib';
import {
    decodeChunk as decodeSharedChunk,
    ReplayDecodeError,
    type ChunkAccumulator,
    type ChunkIndexEntry,
    type ReplayCodec,
} from 'shared';
import { NETWORK } from '../config/network';

export {
    REPLAY_MAGIC,
    REPLAY_CONTAINER_VERSION,
    REPLAY_FORMAT_VERSION,
    FRAMES_PER_CHUNK,
    ReplayDecodeError,
    buildReplayContainer,
    parseReplayContainer,
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

/**
 * 출력 상한을 넘는 즉시 gzip 스트림을 끊는다. 결과를 전부 만든 뒤 길이를 재면 압축 폭탄을
 * 막았다는 오류가 뜰 때는 이미 메모리를 다 쓴 뒤다.
 */
export function gunzipWithinLimit(data: Uint8Array, maxOutputBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
        return Promise.reject(new ReplayDecodeError(`invalid chunk raw limit: ${maxOutputBytes}`));
    }

    return new Promise((resolve, reject) => {
        const gunzip = createGunzip();
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;

        const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            reject(error);
            gunzip.destroy();
        };

        gunzip.on('data', (chunk: Buffer) => {
            if (total + chunk.byteLength > maxOutputBytes) {
                fail(new ReplayDecodeError(`chunk exceeds declared raw length: ${maxOutputBytes}`));
                return;
            }
            total += chunk.byteLength;
            chunks.push(chunk);
        });
        gunzip.once('error', (error) => fail(error));
        gunzip.once('end', () => {
            if (settled) return;
            settled = true;
            const out = Buffer.concat(chunks, total);
            resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
        });
        gunzip.end(data);
    });
}

function replayCodecWithRawLimit(maxOutputBytes: number): ReplayCodec {
    return {
        gzip: nodeReplayCodec.gzip,
        gunzip: (data) => gunzipWithinLimit(data, maxOutputBytes),
        sha256: nodeReplayCodec.sha256,
    };
}

/** `node:zlib`과 `node:crypto`로 만든 코덱. 압축 해제는 최종 전역 상한도 스트리밍으로 지킨다. */
export const nodeReplayCodec: ReplayCodec = {
    async gzip(data) {
        const out = gzipSync(data);
        return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    },
    async gunzip(data) {
        return gunzipWithinLimit(data, NETWORK.MAX_REPLAY_CHUNK_RAW_BYTES);
    },
    async sha256(data) {
        const out = createHash('sha256').update(data).digest();
        return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    },
};

/** 조각이 스스로 선언한 rawLen을 그 조각 압축 해제의 상한으로 사용한다. */
export function decodeNodeReplayChunk(
    containerBytes: Uint8Array,
    entry: ChunkIndexEntry,
): Promise<ChunkAccumulator> {
    const limit = Math.min(entry.rawLen, NETWORK.MAX_REPLAY_CHUNK_RAW_BYTES);
    return decodeSharedChunk(containerBytes, entry, replayCodecWithRawLimit(limit));
}
