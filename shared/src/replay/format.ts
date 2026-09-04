/**
 * 리플레이 파일 형식. 이 파일이 형식의 원본이고, 요구는 BASE.md §7.2에 있다.
 *
 * 프레임 바이트 자체는 이 파일이 모른다 — 스냅샷 인코더가 만든 것을 그대로 받아 chunk에 채워
 * 넣을 뿐이다. 형식이 갈라지지 않게 하려면 여기서 새 인코딩을 만들면 안 된다.
 *
 *   magic "SWRP" + containerVersion(u16)
 *   manifest (JSON, 길이 접두)
 *   chunk index (chunk마다 startTick, endTick, offset, compressedLen, rawLen, sha256)
 *   compressed chunks (gzip, chunk 단위 — 탐색 시 필요한 chunk만 푼다)
 *
 * **gzip과 sha256은 주입받는다.** 노드는 `node:zlib`·`node:crypto`를, 브라우저는
 * `DecompressionStream`과 `crypto.subtle`을 쓴다. 둘 다 같은 형식을 읽어야 하는데 그러려면 이
 * 파일이 어느 쪽에도 묶이면 안 된다. 브라우저 쪽이 비동기라서 압축·해시를 건드리는 함수는 전부
 * 비동기다 — 대신 헤더만 읽는 `parseReplayContainer`는 동기로 남는다. 파일을 열자마자 무엇인지
 * 보여 주는 경로에 await가 끼면 화면이 한 박자 늦는다.
 */

export const REPLAY_MAGIC = 'SWRP';
export const REPLAY_CONTAINER_VERSION = 1;
export const REPLAY_FORMAT_VERSION = 1;
/** 2초 * 30Hz. chunk의 첫 프레임은 항상 full 스냅샷이라 탐색 시 처음부터 재생하지 않아도 된다. */
export const FRAMES_PER_CHUNK = 60;

/** 신뢰할 수 없는 입력이라고 가정하고 두는 상한. 파서는 이걸 넘는 선언을 보면 바로 거부한다. */
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_CHUNKS = 10_000;
const MAX_RAW_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_JSON_BYTES = 4_096;
const SHA256_BYTES = 32;
const CHUNK_INDEX_ENTRY_BYTES = 4 + 4 + 4 + 4 + 4 + SHA256_BYTES;

/**
 * 압축과 해시를 넣어 주는 자리.
 *
 * 구현은 압축 해제 결과 크기를 스스로 제한하지 않아도 된다 — 그건 이 파일이 `rawLen` 상한으로
 * 막는다. 남이 준 파일을 여는 화면이 이 코덱을 쓴다는 것만 기억하면 된다.
 */
export interface ReplayCodec {
    gzip(data: Uint8Array): Promise<Uint8Array>;
    gunzip(data: Uint8Array): Promise<Uint8Array>;
    sha256(data: Uint8Array): Promise<Uint8Array>;
}

export class ReplayDecodeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ReplayDecodeError';
    }
}

export interface ReplayEvent {
    kind: 'tagged' | 'eliminated' | 'blinked' | 'skillUsed' | 'skillArea';
    playerId: number;
    by?: number;
    fromX?: number;
    fromY?: number;
    slot?: number;
    targetPlayerId?: number;
    skillId?: string;
}

export interface RecordedFrame {
    tick: number;
    full: boolean;
    bytes: Uint8Array;
}

export interface RecordedVisibility {
    tick: number;
    masks: Uint8Array;
}

export interface RecordedEvent {
    tick: number;
    event: ReplayEvent;
}

export interface ChunkAccumulator {
    frames: RecordedFrame[];
    visibilities: RecordedVisibility[];
    events: RecordedEvent[];
}

export interface ReplayManifest {
    replayFormatVersion: number;
    matchId: string;
    mapId: string;
    snapshotHz: number;
    startTick: number;
    endTick: number;
    durationTicks: number;

    buildId: string;
    protocolVersion: number;
    rulesVersion: string;
    mapBundleHash: string;
    visibilityCoreVersion: number;

    /**
     * 이 파일이 만들어진 시각(epoch ms).
     *
     * 파일을 남에게 주는 순간, 언제 경기인지를 파일 밖에서 알 방법이 없다. 형식 1로 만들어진
     * 파일에는 없으므로 읽는 쪽은 없을 수 있다고 보고 다뤄야 한다.
     */
    recordedAt?: number;

    /** userId를 넣지 않는다. 리플레이 파일이 공유되면 계정 식별자는 되돌릴 수 없다. */
    participants: { playerId: number; nickname: string; colorIndex: number; guest: boolean }[];
    chunkCount: number;
    /** chunk 해시 목록에 대한 SHA-256. */
    rootHash: string;
}

export interface ChunkIndexEntry {
    startTick: number;
    endTick: number;
    offset: number;
    compressedLen: number;
    rawLen: number;
    sha256: string;
}

export interface ReplayContainer {
    bytes: Uint8Array;
    chunkCount: number;
    rootHash: string;
    sizeBytes: number;
}

/* ────────────────────────────── 바이트 도구 ────────────────────────────── */

/*
 * TextEncoder/TextDecoder는 노드에도 브라우저에도 전역으로 있지만, `shared`의 lib은 ES2022뿐이라
 * 타입이 없다. lib에 DOM을 더하면 이 패키지에서 `document` 같은 것도 보이게 된다 — 서버가 함께
 * 쓰는 코드에 브라우저 전역을 열어 두고 싶지 않아서, 쓰는 만큼만 여기서 선언한다.
 */
declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };
declare const TextDecoder: { new (): { decode(input: Uint8Array): string } };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(parts: readonly Uint8Array[]): Uint8Array {
    let total = 0;
    for (const part of parts) total += part.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

function u32(value: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    return out;
}

function viewOf(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function toHex(bytes: Uint8Array): string {
    let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
    return out;
}

function fromHex(hex: string): Uint8Array {
    if (hex.length % 2 !== 0) throw new ReplayDecodeError(`bad hex length: ${hex.length}`);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        if (Number.isNaN(byte)) throw new ReplayDecodeError('bad hex digit');
        out[i] = byte;
    }
    return out;
}

/* ────────────────────────────── chunk 내부 raw 레이아웃 ────────────────────────────── */
/*
 *   [u32 frameCount]       repeated [u32 tick][u8 flags][u32 len][frame bytes]
 *   [u32 visibilityCount]  repeated [u32 tick][8 bytes masks]
 *   [u32 eventCount]       repeated [u32 tick][u16 jsonLen][json bytes]
 */

function encodeRawChunk(chunk: ChunkAccumulator): Uint8Array {
    const parts: Uint8Array[] = [u32(chunk.frames.length)];

    for (const frame of chunk.frames) {
        const head = new Uint8Array(4 + 1 + 4);
        const view = new DataView(head.buffer);
        view.setUint32(0, frame.tick, true);
        view.setUint8(4, frame.full ? 1 : 0);
        view.setUint32(5, frame.bytes.byteLength, true);
        parts.push(head, frame.bytes);
    }

    parts.push(u32(chunk.visibilities.length));
    for (const vis of chunk.visibilities) {
        parts.push(u32(vis.tick));
        const masks = new Uint8Array(8);
        masks.set(vis.masks.subarray(0, Math.min(8, vis.masks.byteLength)));
        parts.push(masks);
    }

    parts.push(u32(chunk.events.length));
    for (const rec of chunk.events) {
        const json = encoder.encode(JSON.stringify(rec.event));
        if (json.byteLength > MAX_EVENT_JSON_BYTES) throw new Error(`replay event too large: ${json.byteLength} bytes`);
        const head = new Uint8Array(4 + 2);
        const view = new DataView(head.buffer);
        view.setUint32(0, rec.tick, true);
        view.setUint16(4, json.byteLength, true);
        parts.push(head, json);
    }

    return concat(parts);
}

function decodeRawChunk(raw: Uint8Array): ChunkAccumulator {
    const view = viewOf(raw);
    let p = 0;
    const need = (n: number): void => {
        if (p + n > raw.byteLength) throw new ReplayDecodeError('chunk truncated');
    };

    need(4);
    const frameCount = view.getUint32(p, true);
    p += 4;
    if (frameCount > FRAMES_PER_CHUNK * 4) throw new ReplayDecodeError(`chunk claims too many frames: ${frameCount}`);
    const frames: RecordedFrame[] = [];
    for (let i = 0; i < frameCount; i++) {
        need(9);
        const tick = view.getUint32(p, true);
        const full = view.getUint8(p + 4) !== 0;
        const bodyLen = view.getUint32(p + 5, true);
        p += 9;
        need(bodyLen);
        frames.push({ tick, full, bytes: raw.slice(p, p + bodyLen) });
        p += bodyLen;
    }

    need(4);
    const visCount = view.getUint32(p, true);
    p += 4;
    if (visCount > FRAMES_PER_CHUNK * 4) throw new ReplayDecodeError(`chunk claims too many visibility entries: ${visCount}`);
    const visibilities: RecordedVisibility[] = [];
    for (let i = 0; i < visCount; i++) {
        need(4 + 8);
        const tick = view.getUint32(p, true);
        p += 4;
        visibilities.push({ tick, masks: raw.slice(p, p + 8) });
        p += 8;
    }

    need(4);
    const eventCount = view.getUint32(p, true);
    p += 4;
    if (eventCount > FRAMES_PER_CHUNK * 64) throw new ReplayDecodeError(`chunk claims too many events: ${eventCount}`);
    const events: RecordedEvent[] = [];
    for (let i = 0; i < eventCount; i++) {
        need(6);
        const tick = view.getUint32(p, true);
        const jsonLen = view.getUint16(p + 4, true);
        p += 6;
        need(jsonLen);
        const event = JSON.parse(decoder.decode(raw.subarray(p, p + jsonLen))) as ReplayEvent;
        events.push({ tick, event });
        p += jsonLen;
    }

    return { frames, visibilities, events };
}

/* ────────────────────────────── 컨테이너 조립/파싱 ────────────────────────────── */

export async function buildReplayContainer(
    manifestBase: Omit<ReplayManifest, 'chunkCount' | 'rootHash'>,
    chunks: readonly ChunkAccumulator[],
    codec: ReplayCodec,
): Promise<ReplayContainer> {
    if (chunks.length === 0) throw new Error('cannot build a replay container with no chunks');
    if (chunks.length > MAX_CHUNKS) throw new Error(`too many chunks: ${chunks.length}`);

    const compressedChunks: Uint8Array[] = [];
    const chunkHashes: Uint8Array[] = [];
    const partialIndex: Omit<ChunkIndexEntry, 'offset'>[] = [];

    for (const chunk of chunks) {
        const raw = encodeRawChunk(chunk);
        const compressed = await codec.gzip(raw);
        const sha256 = await codec.sha256(compressed);
        compressedChunks.push(compressed);
        chunkHashes.push(sha256);
        const ticks = chunk.frames.map((frame) => frame.tick);
        partialIndex.push({
            startTick: ticks[0] ?? manifestBase.startTick,
            endTick: ticks[ticks.length - 1] ?? manifestBase.startTick,
            compressedLen: compressed.byteLength,
            rawLen: raw.byteLength,
            sha256: toHex(sha256),
        });
    }

    const rootHash = toHex(await codec.sha256(concat(chunkHashes)));
    const manifest: ReplayManifest = { ...manifestBase, chunkCount: chunks.length, rootHash };
    const manifestJson = encoder.encode(JSON.stringify(manifest));
    if (manifestJson.byteLength > MAX_MANIFEST_BYTES) {
        throw new Error(`replay manifest too large: ${manifestJson.byteLength} bytes`);
    }

    const headerLen = 4 + 2 + 4;
    const indexLen = 4 + chunks.length * CHUNK_INDEX_ENTRY_BYTES;
    let cursor = headerLen + manifestJson.byteLength + indexLen;
    const fullIndex: ChunkIndexEntry[] = partialIndex.map((entry, i) => {
        const offset = cursor;
        cursor += compressedChunks[i]!.byteLength;
        return { ...entry, offset };
    });

    const versionBuf = new Uint8Array(2);
    new DataView(versionBuf.buffer).setUint16(0, REPLAY_CONTAINER_VERSION, true);
    const parts: Uint8Array[] = [
        encoder.encode(REPLAY_MAGIC),
        versionBuf,
        u32(manifestJson.byteLength),
        manifestJson,
        u32(fullIndex.length),
    ];

    for (const entry of fullIndex) {
        const buf = new Uint8Array(CHUNK_INDEX_ENTRY_BYTES);
        const view = new DataView(buf.buffer);
        view.setUint32(0, entry.startTick, true);
        view.setUint32(4, entry.endTick, true);
        view.setUint32(8, entry.offset, true);
        view.setUint32(12, entry.compressedLen, true);
        view.setUint32(16, entry.rawLen, true);
        buf.set(fromHex(entry.sha256), 20);
        parts.push(buf);
    }
    parts.push(...compressedChunks);

    const bytes = concat(parts);
    return { bytes, chunkCount: fullIndex.length, rootHash, sizeBytes: bytes.byteLength };
}

export function parseReplayContainer(bytes: Uint8Array): { manifest: ReplayManifest; chunkIndex: ChunkIndexEntry[] } {
    if (bytes.byteLength < 10) throw new ReplayDecodeError(`file too short: ${bytes.byteLength} bytes`);
    const view = viewOf(bytes);
    const magic = decoder.decode(bytes.subarray(0, 4));
    if (magic !== REPLAY_MAGIC) throw new ReplayDecodeError(`bad magic: ${magic}`);
    const containerVersion = view.getUint16(4, true);
    if (containerVersion !== REPLAY_CONTAINER_VERSION) {
        throw new ReplayDecodeError(`unsupported container version: ${containerVersion}`);
    }

    let p = 6;
    if (p + 4 > bytes.byteLength) throw new ReplayDecodeError('truncated header');
    const manifestLen = view.getUint32(p, true);
    p += 4;
    if (manifestLen > MAX_MANIFEST_BYTES || p + manifestLen > bytes.byteLength) {
        throw new ReplayDecodeError(`bad manifest length: ${manifestLen}`);
    }
    let manifest: ReplayManifest;
    try {
        manifest = JSON.parse(decoder.decode(bytes.subarray(p, p + manifestLen))) as ReplayManifest;
    } catch {
        // 남이 준 파일이다. 깨진 JSON이 파서 밖으로 다른 오류를 던지면 화면이 그것을 설명하지 못한다.
        throw new ReplayDecodeError('manifest is not valid JSON');
    }
    p += manifestLen;

    if (p + 4 > bytes.byteLength) throw new ReplayDecodeError('truncated chunk index header');
    const chunkCount = view.getUint32(p, true);
    p += 4;
    if (chunkCount > MAX_CHUNKS) throw new ReplayDecodeError(`too many chunks declared: ${chunkCount}`);

    const chunkIndex: ChunkIndexEntry[] = [];
    for (let i = 0; i < chunkCount; i++) {
        if (p + CHUNK_INDEX_ENTRY_BYTES > bytes.byteLength) throw new ReplayDecodeError('truncated chunk index entry');
        const startTick = view.getUint32(p, true);
        const endTick = view.getUint32(p + 4, true);
        const offset = view.getUint32(p + 8, true);
        const compressedLen = view.getUint32(p + 12, true);
        const rawLen = view.getUint32(p + 16, true);
        const sha256 = toHex(bytes.subarray(p + 20, p + 20 + SHA256_BYTES));
        p += CHUNK_INDEX_ENTRY_BYTES;
        if (rawLen > MAX_RAW_CHUNK_BYTES) throw new ReplayDecodeError(`chunk claims too much raw data: ${rawLen}`);
        if (offset + compressedLen > bytes.byteLength) throw new ReplayDecodeError('chunk index points past end of file');
        chunkIndex.push({ startTick, endTick, offset, compressedLen, rawLen, sha256 });
    }

    return { manifest, chunkIndex };
}

/** chunk 하나를 압축 해제하고 해시를 검증한다. 손상된 저장소를 조용히 읽지 않기 위해서다. */
export async function decodeChunk(
    containerBytes: Uint8Array,
    entry: ChunkIndexEntry,
    codec: ReplayCodec,
): Promise<ChunkAccumulator> {
    if (entry.offset + entry.compressedLen > containerBytes.byteLength) {
        throw new ReplayDecodeError('chunk range out of bounds');
    }
    const compressed = containerBytes.subarray(entry.offset, entry.offset + entry.compressedLen);
    const actualHash = toHex(await codec.sha256(compressed));
    if (actualHash !== entry.sha256) throw new ReplayDecodeError('chunk hash mismatch, storage may be corrupted');
    const raw = await codec.gunzip(compressed);
    // 압축 폭탄은 여기서 걸린다. 선언한 길이와 실제가 다르면 그 자체로 믿을 수 없는 파일이다.
    if (raw.byteLength !== entry.rawLen) throw new ReplayDecodeError('chunk raw length mismatch after decompression');
    return decodeRawChunk(raw);
}

/** manifest.rootHash가 실제 chunk 해시 목록과 일치하는지 확인한다. */
export async function verifyRootHash(
    manifest: ReplayManifest,
    chunkIndex: readonly ChunkIndexEntry[],
    codec: ReplayCodec,
): Promise<boolean> {
    const digestBytes = concat(chunkIndex.map((entry) => fromHex(entry.sha256)));
    return toHex(await codec.sha256(digestBytes)) === manifest.rootHash;
}
