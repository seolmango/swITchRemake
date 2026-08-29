import {
    decodeChunk,
    parseReplayContainer,
    ReplayDecodeError,
    verifyRootHash,
    type ChunkIndexEntry,
    type RecordedFrame,
    type ReplayManifest,
} from 'shared';
import { browserReplayCodec } from './browserCodec.ts';

/**
 * 열어 본 리플레이 파일 하나.
 *
 * 검증 상태를 네 갈래로 나누는 것이 이 파일의 요점이다(`docs/FUTURE.md` §8).
 *
 * - `verified`   — 서버가 서명했고 내용이 그대로다. **아직 아무 파일도 이 상태가 아니다.**
 *                  서명이 구현되기 전이다
 * - `modified`   — chunk 해시가 manifest의 rootHash와 안 맞는다. 손상됐거나 누가 건드렸다
 * - `unverified` — 서명이 없다. 조작됐다는 뜻이 아니라, **우리가 확인할 방법이 없다**는 뜻이다
 * - `unsupported`— 안전하게 파싱할 수 없다. 형식이 다르거나 파일이 아니다
 *
 * `modified`와 `unverified`를 한 덩어리로 묶으면 안 된다. 하나는 경고고 하나는 사실 진술이다.
 */
export type ReplayVerification = 'verified' | 'modified' | 'unverified' | 'unsupported';

export interface OpenedReplay {
    bytes: Uint8Array;
    manifest: ReplayManifest;
    chunkIndex: ChunkIndexEntry[];
    verification: ReplayVerification;
}

export class ReplayOpenError extends Error {
    readonly verification: ReplayVerification;
    constructor(message: string, verification: ReplayVerification) {
        super(message);
        this.name = 'ReplayOpenError';
        this.verification = verification;
    }
}

/**
 * 파일 하나를 열어 헤더를 읽고 무결성을 확인한다.
 *
 * 재생을 시작하기 전에 chunk를 전부 풀지는 않는다 — 큰 파일에서 화면이 멈춘다. rootHash만
 * 맞춰 보고, 실제 chunk 해시는 그 chunk를 풀 때 `decodeChunk`가 확인한다.
 */
export async function openReplay(bytes: Uint8Array): Promise<OpenedReplay> {
    let parsed: { manifest: ReplayManifest; chunkIndex: ChunkIndexEntry[] };
    try {
        parsed = parseReplayContainer(bytes);
    } catch (error) {
        throw new ReplayOpenError(
            error instanceof ReplayDecodeError ? error.message : 'replay file could not be parsed',
            'unsupported',
        );
    }

    const rootOk = await verifyRootHash(parsed.manifest, parsed.chunkIndex, browserReplayCodec);
    return {
        bytes,
        manifest: parsed.manifest,
        chunkIndex: parsed.chunkIndex,
        // 서명이 아직 없다. 붙기 전까지 성한 파일이 갈 수 있는 최선은 '확인할 수 없음'이다.
        verification: rootOk ? 'unverified' : 'modified',
    };
}

/** chunk 하나를 풀어 프레임만 꺼낸다. 해시 검증은 `decodeChunk`가 한다. */
export async function loadFrames(replay: OpenedReplay, chunkIndexPosition: number): Promise<RecordedFrame[]> {
    const entry = replay.chunkIndex[chunkIndexPosition];
    if (!entry) return [];
    const chunk = await decodeChunk(replay.bytes, entry, browserReplayCodec);
    return chunk.frames;
}

/** 프레임 바이트는 `ArrayBuffer`로 넘겨야 한다. 엔진의 스냅샷 디코더가 그것을 받는다. */
export function frameBuffer(frame: RecordedFrame): ArrayBuffer {
    return frame.bytes.buffer.slice(
        frame.bytes.byteOffset,
        frame.bytes.byteOffset + frame.bytes.byteLength,
    ) as ArrayBuffer;
}
