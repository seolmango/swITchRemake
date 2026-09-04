import { ReplayDecodeError, type ReplayCodec } from 'shared';

/**
 * 브라우저용 리플레이 코덱.
 *
 * `DecompressionStream`과 `crypto.subtle` 둘 다 비동기다. 그래서 `shared`의 코덱 포트가
 * 애초에 약속(Promise)을 돌려주게 되어 있다.
 *
 * `crypto.subtle`은 **보안 컨텍스트에서만** 있다(https 또는 localhost). 그 밖에서는 재생기가
 * 아예 안 열리는데, 그때 조용히 실패하면 사용자는 파일이 깨진 줄 안다. 그래서 없으면 그 사실을
 * 말하는 오류를 던진다.
 */

const MAX_REPLAY_CHUNK_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * 스트림이 상한을 넘는 순간 취소한다. 다 모은 뒤 길이를 재면 압축 폭탄이 이미 메모리를 쓴 뒤다.
 */
export async function collectReplayStream(
    stream: ReadableStream<Uint8Array>,
    maxOutputBytes: number,
): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
        throw new ReplayDecodeError(`invalid decompression limit: ${maxOutputBytes}`);
    }
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.byteLength > maxOutputBytes - total) {
                // pipeThrough의 reader를 취소하면 압축 해제기와 그 입력 Blob까지 취소가 전파된다.
                await reader.cancel('replay decompression limit exceeded');
                throw new ReplayDecodeError(`replay chunk exceeds ${maxOutputBytes} decompressed bytes`);
            }
            parts.push(value);
            total += value.byteLength;
        }
    } finally {
        reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

function through(
    data: Uint8Array,
    transform: GenericTransformStream,
    maxOutputBytes: number,
): Promise<Uint8Array> {
    const source = new Blob([data as BlobPart]).stream() as ReadableStream<Uint8Array>;
    return collectReplayStream(source.pipeThrough(transform) as ReadableStream<Uint8Array>, maxOutputBytes);
}

export interface BrowserReplayCodec extends ReplayCodec {
    gunzip(data: Uint8Array, maxOutputBytes?: number): Promise<Uint8Array>;
}

export const browserReplayCodec: BrowserReplayCodec = {
    gzip(data) {
        // 녹화 파일을 만드는 경로는 브라우저 재생기에 없지만 공용 포트의 대칭을 유지한다.
        return through(data, new CompressionStream('gzip'), MAX_REPLAY_CHUNK_OUTPUT_BYTES);
    },
    gunzip(data, maxOutputBytes = MAX_REPLAY_CHUNK_OUTPUT_BYTES) {
        return through(data, new DecompressionStream('gzip'), maxOutputBytes);
    },
    async sha256(data) {
        if (!globalThis.crypto?.subtle) {
            throw new Error('이 브라우저 컨텍스트에는 crypto.subtle이 없습니다(https 또는 localhost가 필요합니다).');
        }
        const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
        return new Uint8Array(digest);
    },
};

/** 공용 decodeChunk가 호출하는 gunzip에도 해당 인덱스가 선언한 실제 상한을 전달한다. */
export function browserReplayCodecWithLimit(maxOutputBytes: number): ReplayCodec {
    return {
        gzip: (data) => browserReplayCodec.gzip(data),
        gunzip: (data) => browserReplayCodec.gunzip(data, maxOutputBytes),
        sha256: (data) => browserReplayCodec.sha256(data),
    };
}
