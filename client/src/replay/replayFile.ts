import {
    checkReplaySignature,
    decodeChunk,
    parseReplayContainer,
    ReplayDecodeError,
    MAX_PLAYERS_PER_ROOM,
    REPLAY_FORMAT_VERSION,
    verifyRootHash,
    type ChunkIndexEntry,
    type RecordedFrame,
    type ReplayManifest,
    type ReplayVerifier,
} from 'shared';
import { browserReplayCodec, browserReplayCodecWithLimit } from './browserCodec.ts';

/** 파일 자체와 모든 chunk 원문의 합을 따로 제한해야 압축률과 chunk 개수 양쪽을 막을 수 있다. */
export const MAX_REPLAY_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_REPLAY_TOTAL_RAW_BYTES = 128 * 1024 * 1024;

interface ReplayFileSource {
    readonly size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
}

export async function readReplayFile(file: ReplayFileSource): Promise<Uint8Array> {
    // arrayBuffer()보다 먼저 검사해야 큰 파일을 한 번 메모리에 올린 뒤 거절하는 실수를 피한다.
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_REPLAY_FILE_BYTES) {
        throw new ReplayOpenError(`replay file exceeds ${MAX_REPLAY_FILE_BYTES} bytes`, 'unsupported');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    // File이 아닌 테스트·임베드 호출자도 같은 경계를 우회하지 못하게 실제 결과도 다시 확인한다.
    if (bytes.byteLength > MAX_REPLAY_FILE_BYTES) {
        throw new ReplayOpenError(`replay file exceeds ${MAX_REPLAY_FILE_BYTES} bytes`, 'unsupported');
    }
    return bytes;
}

/**
 * 열어 본 리플레이 파일 하나.
 *
 * 검증 상태를 네 갈래로 나누는 것이 이 파일의 요점이다(BASE.md §7.2).
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function invalidManifest(field: string): never {
    throw new ReplayDecodeError(`invalid replay manifest field: ${field}`);
}

/** JSON.parse의 타입 단언은 런타임 검증이 아니므로 화면에서 쓰는 필드를 하나씩 확인한다. */
export function validateReplayMetadata(
    manifestValue: unknown,
    chunkIndex: readonly ChunkIndexEntry[],
): asserts manifestValue is ReplayManifest {
    if (!isRecord(manifestValue)) invalidManifest('manifest');
    const manifest = manifestValue;

    if (manifest['replayFormatVersion'] !== REPLAY_FORMAT_VERSION) invalidManifest('replayFormatVersion');
    if (!isBoundedString(manifest['matchId'], 128)) invalidManifest('matchId');
    if (!isBoundedString(manifest['mapId'], 128)) invalidManifest('mapId');
    if (!Number.isSafeInteger(manifest['snapshotHz']) || (manifest['snapshotHz'] as number) < 1
        || (manifest['snapshotHz'] as number) > 240) invalidManifest('snapshotHz');
    if (!isSafeNonNegativeInteger(manifest['startTick'])) invalidManifest('startTick');
    if (!isSafeNonNegativeInteger(manifest['endTick'])) invalidManifest('endTick');
    if (!isSafeNonNegativeInteger(manifest['durationTicks'])) invalidManifest('durationTicks');
    if ((manifest['endTick'] as number) < (manifest['startTick'] as number)
        || manifest['durationTicks'] !== (manifest['endTick'] as number) - (manifest['startTick'] as number)) {
        invalidManifest('tick range');
    }
    if (!isBoundedString(manifest['buildId'], 128)) invalidManifest('buildId');
    if (!isSafeNonNegativeInteger(manifest['protocolVersion'])) invalidManifest('protocolVersion');
    if (!isBoundedString(manifest['rulesVersion'], 128)) invalidManifest('rulesVersion');
    if (typeof manifest['mapBundleHash'] !== 'string' || !/^[0-9a-f]{64}$/iu.test(manifest['mapBundleHash'])) {
        invalidManifest('mapBundleHash');
    }
    if (!isSafeNonNegativeInteger(manifest['visibilityCoreVersion'])) invalidManifest('visibilityCoreVersion');
    if (manifest['recordedAt'] !== undefined && !isSafeNonNegativeInteger(manifest['recordedAt'])) {
        invalidManifest('recordedAt');
    }
    if (!Array.isArray(manifest['participants']) || manifest['participants'].length < 1
        || manifest['participants'].length > MAX_PLAYERS_PER_ROOM) invalidManifest('participants');

    const playerIds = new Set<number>();
    for (const participantValue of manifest['participants']) {
        if (!isRecord(participantValue)) invalidManifest('participants[]');
        const playerId = participantValue['playerId'];
        if (!Number.isSafeInteger(playerId) || (playerId as number) < 1
            || (playerId as number) > MAX_PLAYERS_PER_ROOM || playerIds.has(playerId as number)) {
            invalidManifest('participants[].playerId');
        }
        playerIds.add(playerId as number);
        if (!isBoundedString(participantValue['nickname'], 20)) invalidManifest('participants[].nickname');
        if (!Number.isSafeInteger(participantValue['colorIndex']) || (participantValue['colorIndex'] as number) < 0
            || (participantValue['colorIndex'] as number) >= MAX_PLAYERS_PER_ROOM) {
            invalidManifest('participants[].colorIndex');
        }
        if (typeof participantValue['guest'] !== 'boolean') invalidManifest('participants[].guest');
    }

    if (!Number.isSafeInteger(manifest['chunkCount']) || manifest['chunkCount'] !== chunkIndex.length
        || chunkIndex.length < 1) invalidManifest('chunkCount');
    if (typeof manifest['rootHash'] !== 'string' || !/^[0-9a-f]{64}$/iu.test(manifest['rootHash'])) {
        invalidManifest('rootHash');
    }

    let totalRawBytes = 0;
    for (const entry of chunkIndex) {
        if (!Number.isSafeInteger(entry.rawLen) || entry.rawLen < 1) {
            throw new ReplayDecodeError('invalid replay chunk raw length');
        }
        totalRawBytes += entry.rawLen;
        if (!Number.isSafeInteger(totalRawBytes) || totalRawBytes > MAX_REPLAY_TOTAL_RAW_BYTES) {
            throw new ReplayDecodeError(`replay chunks exceed ${MAX_REPLAY_TOTAL_RAW_BYTES} raw bytes`);
        }
    }
}

/**
 * 파일 하나를 열어 헤더를 읽고 무결성을 확인한다.
 *
 * 재생을 시작하기 전에 chunk를 전부 풀지는 않는다 — 큰 파일에서 화면이 멈춘다. rootHash만
 * 맞춰 보고, 실제 chunk 해시는 그 chunk를 풀 때 `decodeChunk`가 확인한다.
 */
export async function openReplay(bytes: Uint8Array, verifier?: ReplayVerifier): Promise<OpenedReplay> {
    if (bytes.byteLength > MAX_REPLAY_FILE_BYTES) {
        throw new ReplayOpenError(`replay file exceeds ${MAX_REPLAY_FILE_BYTES} bytes`, 'unsupported');
    }
    let parsed: { manifest: ReplayManifest; chunkIndex: ChunkIndexEntry[] };
    try {
        parsed = parseReplayContainer(bytes);
        validateReplayMetadata(parsed.manifest, parsed.chunkIndex);
    } catch (error) {
        throw new ReplayOpenError(
            error instanceof ReplayDecodeError ? error.message : 'replay file could not be parsed',
            'unsupported',
        );
    }

    const rootOk = await verifyRootHash(parsed.manifest, parsed.chunkIndex, browserReplayCodec);
    /*
     * 순서가 중요하다. 해시가 이미 깨졌으면 서명을 볼 것도 없이 바뀐 파일이다 — 서명이 맞더라도
     * 그 서명은 지금 이 바이트에 대한 것이 아니다.
     */
    let verification: ReplayVerification = rootOk ? 'unverified' : 'modified';
    if (rootOk && verifier) {
        const signature = await checkReplaySignature(bytes, verifier);
        // 'absent'와 'unknown-key'는 둘 다 확인할 수 없다는 사실 진술이다. 'forged'만 경고다.
        if (signature === 'signed') verification = 'verified';
        else if (signature === 'forged') verification = 'modified';
    }

    return { bytes, manifest: parsed.manifest, chunkIndex: parsed.chunkIndex, verification };
}

/** chunk 하나를 풀어 프레임만 꺼낸다. 해시 검증은 `decodeChunk`가 한다. */
export async function loadFrames(replay: OpenedReplay, chunkIndexPosition: number): Promise<RecordedFrame[]> {
    const entry = replay.chunkIndex[chunkIndexPosition];
    if (!entry) return [];
    const chunk = await decodeChunk(replay.bytes, entry, browserReplayCodecWithLimit(entry.rawLen));
    return chunk.frames;
}

/** 프레임 바이트는 `ArrayBuffer`로 넘겨야 한다. 엔진의 스냅샷 디코더가 그것을 받는다. */
export function frameBuffer(frame: RecordedFrame): ArrayBuffer {
    return frame.bytes.buffer.slice(
        frame.bytes.byteOffset,
        frame.bytes.byteOffset + frame.bytes.byteLength,
    ) as ArrayBuffer;
}
