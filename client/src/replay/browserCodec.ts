import type { ReplayCodec } from 'shared';

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

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

function through(data: Uint8Array, transform: GenericTransformStream): Promise<Uint8Array> {
    const source = new Blob([data as BlobPart]).stream() as ReadableStream<Uint8Array>;
    return collect(source.pipeThrough(transform) as ReadableStream<Uint8Array>);
}

export const browserReplayCodec: ReplayCodec = {
    gzip(data) {
        return through(data, new CompressionStream('gzip'));
    },
    gunzip(data) {
        return through(data, new DecompressionStream('gzip'));
    },
    async sha256(data) {
        if (!globalThis.crypto?.subtle) {
            throw new Error('이 브라우저 컨텍스트에는 crypto.subtle이 없습니다(https 또는 localhost가 필요합니다).');
        }
        const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
        return new Uint8Array(digest);
    },
};
