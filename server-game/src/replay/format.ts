/**
 * 리플레이 파일 형식. `docs/REPLAY.md` 5절이 원본이다.
 *
 * 프레임 바이트 자체는 이 파일이 모른다 — `shared`의 스냅샷 인코더가 만든 것을 그대로 받아
 * chunk에 채워 넣을 뿐이다. 형식이 갈라지지 않게 하려면 여기서 새 인코딩을 만들면 안 된다.
 *
 *   magic "SWRP" + containerVersion(u16)
 *   manifest (JSON, 길이 접두)
 *   chunk index (chunk마다 startTick, endTick, offset, compressedLen, rawLen, sha256)
 *   compressed chunks (gzip, chunk 단위 — 탐색 시 필요한 chunk만 푼다)
 */

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

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

/** masks is always 8 bytes; its zero-based index is playerId - 1. */
export interface RecordedVisibility {
    tick: number;
    masks: Uint8Array;
}

export interface RecordedEvent {
    tick: number;
    event: ReplayEvent;
}

/** 레코더가 실시간으로 채우는 chunk 하나. 세 트랙이 같은 chunk 경계를 공유한다. */
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

/* ────────────────────────────── chunk 내부 raw 레이아웃 ────────────────────────────── */
/*
 *   [u32 frameCount]       repeated [u32 tick][u8 flags][u32 len][frame bytes]
 *   [u32 visibilityCount]  repeated [u32 tick][8 bytes masks]
 *   [u32 eventCount]       repeated [u32 tick][u16 jsonLen][json bytes]
 */

function encodeRawChunk(chunk: ChunkAccumulator): Buffer {
    const parts: Buffer[] = [];
    let len = 0;
    const push = (b: Buffer): void => {
        parts.push(b);
        len += b.length;
    };

    const frameCountBuf = Buffer.alloc(4);
    frameCountBuf.writeUInt32LE(chunk.frames.length);
    push(frameCountBuf);
    for (const frame of chunk.frames) {
        const head = Buffer.alloc(4 + 1 + 4);
        head.writeUInt32LE(frame.tick, 0);
        head.writeUInt8(frame.full ? 1 : 0, 4);
        head.writeUInt32LE(frame.bytes.byteLength, 5);
        push(head);
        push(Buffer.from(frame.bytes));
    }

    const visCountBuf = Buffer.alloc(4);
    visCountBuf.writeUInt32LE(chunk.visibilities.length);
    push(visCountBuf);
    for (const vis of chunk.visibilities) {
        const head = Buffer.alloc(4);
        head.writeUInt32LE(vis.tick);
        push(head);
        const masks = Buffer.alloc(8);
        Buffer.from(vis.masks).copy(masks, 0, 0, Math.min(8, vis.masks.byteLength));
        push(masks);
    }

    const eventCountBuf = Buffer.alloc(4);
    eventCountBuf.writeUInt32LE(chunk.events.length);
    push(eventCountBuf);
    for (const rec of chunk.events) {
        const json = Buffer.from(JSON.stringify(rec.event), 'utf8');
        if (json.byteLength > MAX_EVENT_JSON_BYTES) throw new Error(`replay event too large: ${json.byteLength} bytes`);
        const head = Buffer.alloc(4 + 2);
        head.writeUInt32LE(rec.tick, 0);
        head.writeUInt16LE(json.byteLength, 4);
        push(head);
        push(json);
    }

    return Buffer.concat(parts, len);
}

function decodeRawChunk(raw: Buffer): ChunkAccumulator {
    let p = 0;
    const need = (n: number): void => {
        if (p + n > raw.byteLength) throw new ReplayDecodeError('chunk truncated');
    };

    need(4);
    const frameCount = raw.readUInt32LE(p);
    p += 4;
    if (frameCount > FRAMES_PER_CHUNK * 4) throw new ReplayDecodeError(`chunk claims too many frames: ${frameCount}`);
    const frames: RecordedFrame[] = [];
    for (let i = 0; i < frameCount; i++) {
        need(9);
        const tick = raw.readUInt32LE(p);
        const full = raw.readUInt8(p + 4) !== 0;
        const bodyLen = raw.readUInt32LE(p + 5);
        p += 9;
        need(bodyLen);
        frames.push({ tick, full, bytes: new Uint8Array(raw.subarray(p, p + bodyLen)) });
        p += bodyLen;
    }

    need(4);
    const visCount = raw.readUInt32LE(p);
    p += 4;
    if (visCount > FRAMES_PER_CHUNK * 4) throw new ReplayDecodeError(`chunk claims too many visibility entries: ${visCount}`);
    const visibilities: RecordedVisibility[] = [];
    for (let i = 0; i < visCount; i++) {
        need(4 + 8);
        const tick = raw.readUInt32LE(p);
        p += 4;
        visibilities.push({ tick, masks: new Uint8Array(raw.subarray(p, p + 8)) });
        p += 8;
    }

    need(4);
    const eventCount = raw.readUInt32LE(p);
    p += 4;
    if (eventCount > FRAMES_PER_CHUNK * 64) throw new ReplayDecodeError(`chunk claims too many events: ${eventCount}`);
    const events: RecordedEvent[] = [];
    for (let i = 0; i < eventCount; i++) {
        need(6);
        const tick = raw.readUInt32LE(p);
        const jsonLen = raw.readUInt16LE(p + 4);
        p += 6;
        need(jsonLen);
        const event = JSON.parse(raw.subarray(p, p + jsonLen).toString('utf8')) as ReplayEvent;
        events.push({ tick, event });
        p += jsonLen;
    }

    return { frames, visibilities, events };
}

/* ────────────────────────────── 컨테이너 조립/파싱 ────────────────────────────── */

export function buildReplayContainer(
    manifestBase: Omit<ReplayManifest, 'chunkCount' | 'rootHash'>,
    chunks: readonly ChunkAccumulator[],
): ReplayContainer {
    if (chunks.length === 0) throw new Error('cannot build a replay container with no chunks');
    if (chunks.length > MAX_CHUNKS) throw new Error(`too many chunks: ${chunks.length}`);

    const compressedChunks: Buffer[] = [];
    const chunkHashes: Buffer[] = [];
    const partialIndex: Omit<ChunkIndexEntry, 'offset'>[] = [];

    for (const chunk of chunks) {
        const raw = encodeRawChunk(chunk);
        const compressed = gzipSync(raw);
        const sha256 = createHash('sha256').update(compressed).digest();
        compressedChunks.push(compressed);
        chunkHashes.push(sha256);
        const ticks = chunk.frames.map((f) => f.tick);
        partialIndex.push({
            startTick: ticks[0] ?? manifestBase.startTick,
            endTick: ticks[ticks.length - 1] ?? manifestBase.startTick,
            compressedLen: compressed.byteLength,
            rawLen: raw.byteLength,
            sha256: sha256.toString('hex'),
        });
    }

    const rootHash = createHash('sha256').update(Buffer.concat(chunkHashes)).digest('hex');
    const manifest: ReplayManifest = { ...manifestBase, chunkCount: chunks.length, rootHash };
    const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf8');
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

    const parts: Buffer[] = [Buffer.from(REPLAY_MAGIC, 'ascii')];
    const versionBuf = Buffer.alloc(2);
    versionBuf.writeUInt16LE(REPLAY_CONTAINER_VERSION);
    parts.push(versionBuf);
    const manifestLenBuf = Buffer.alloc(4);
    manifestLenBuf.writeUInt32LE(manifestJson.byteLength);
    parts.push(manifestLenBuf, manifestJson);

    const chunkCountBuf = Buffer.alloc(4);
    chunkCountBuf.writeUInt32LE(fullIndex.length);
    parts.push(chunkCountBuf);
    for (const entry of fullIndex) {
        const buf = Buffer.alloc(CHUNK_INDEX_ENTRY_BYTES);
        let o = 0;
        buf.writeUInt32LE(entry.startTick, o); o += 4;
        buf.writeUInt32LE(entry.endTick, o); o += 4;
        buf.writeUInt32LE(entry.offset, o); o += 4;
        buf.writeUInt32LE(entry.compressedLen, o); o += 4;
        buf.writeUInt32LE(entry.rawLen, o); o += 4;
        Buffer.from(entry.sha256, 'hex').copy(buf, o);
        parts.push(buf);
    }
    parts.push(...compressedChunks);

    const bytes = Buffer.concat(parts);
    return {
        bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        chunkCount: fullIndex.length,
        rootHash,
        sizeBytes: bytes.byteLength,
    };
}

function asBuffer(bytes: Uint8Array): Buffer {
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function parseReplayContainer(bytes: Uint8Array): { manifest: ReplayManifest; chunkIndex: ChunkIndexEntry[] } {
    const buf = asBuffer(bytes);
    if (buf.byteLength < 10) throw new ReplayDecodeError(`file too short: ${buf.byteLength} bytes`);
    const magic = buf.subarray(0, 4).toString('ascii');
    if (magic !== REPLAY_MAGIC) throw new ReplayDecodeError(`bad magic: ${magic}`);
    const containerVersion = buf.readUInt16LE(4);
    if (containerVersion !== REPLAY_CONTAINER_VERSION) {
        throw new ReplayDecodeError(`unsupported container version: ${containerVersion}`);
    }

    let p = 6;
    if (p + 4 > buf.byteLength) throw new ReplayDecodeError('truncated header');
    const manifestLen = buf.readUInt32LE(p);
    p += 4;
    if (manifestLen > MAX_MANIFEST_BYTES || p + manifestLen > buf.byteLength) {
        throw new ReplayDecodeError(`bad manifest length: ${manifestLen}`);
    }
    const manifest = JSON.parse(buf.subarray(p, p + manifestLen).toString('utf8')) as ReplayManifest;
    p += manifestLen;

    if (p + 4 > buf.byteLength) throw new ReplayDecodeError('truncated chunk index header');
    const chunkCount = buf.readUInt32LE(p);
    p += 4;
    if (chunkCount > MAX_CHUNKS) throw new ReplayDecodeError(`too many chunks declared: ${chunkCount}`);

    const chunkIndex: ChunkIndexEntry[] = [];
    for (let i = 0; i < chunkCount; i++) {
        if (p + CHUNK_INDEX_ENTRY_BYTES > buf.byteLength) throw new ReplayDecodeError('truncated chunk index entry');
        const startTick = buf.readUInt32LE(p);
        const endTick = buf.readUInt32LE(p + 4);
        const offset = buf.readUInt32LE(p + 8);
        const compressedLen = buf.readUInt32LE(p + 12);
        const rawLen = buf.readUInt32LE(p + 16);
        const sha256 = buf.subarray(p + 20, p + 20 + SHA256_BYTES).toString('hex');
        p += CHUNK_INDEX_ENTRY_BYTES;
        if (rawLen > MAX_RAW_CHUNK_BYTES) throw new ReplayDecodeError(`chunk claims too much raw data: ${rawLen}`);
        if (offset + compressedLen > buf.byteLength) throw new ReplayDecodeError('chunk index points past end of file');
        chunkIndex.push({ startTick, endTick, offset, compressedLen, rawLen, sha256 });
    }

    return { manifest, chunkIndex };
}

/** chunk 하나를 압축 해제하고 해시를 검증한다. 손상된 저장소를 조용히 읽지 않기 위해서다. */
export function decodeChunk(containerBytes: Uint8Array, entry: ChunkIndexEntry): ChunkAccumulator {
    const buf = asBuffer(containerBytes);
    if (entry.offset + entry.compressedLen > buf.byteLength) throw new ReplayDecodeError('chunk range out of bounds');
    const compressed = buf.subarray(entry.offset, entry.offset + entry.compressedLen);
    const actualHash = createHash('sha256').update(compressed).digest('hex');
    if (actualHash !== entry.sha256) throw new ReplayDecodeError('chunk hash mismatch, storage may be corrupted');
    const raw = gunzipSync(compressed);
    if (raw.byteLength !== entry.rawLen) throw new ReplayDecodeError('chunk raw length mismatch after decompression');
    return decodeRawChunk(raw);
}

/** manifest.rootHash가 실제 chunk 해시 목록과 일치하는지 확인한다. */
export function verifyRootHash(manifest: ReplayManifest, chunkIndex: readonly ChunkIndexEntry[]): boolean {
    const digestBytes = Buffer.concat(chunkIndex.map((e) => Buffer.from(e.sha256, 'hex')));
    const rootHash = createHash('sha256').update(digestBytes).digest('hex');
    return rootHash === manifest.rootHash;
}
