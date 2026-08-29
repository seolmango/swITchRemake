/**
 * `ReplayRecorder` 계약과 메모리 구현. `docs/REPLAY.md` 4절.
 *
 * 게임 루프의 소비자 하나일 뿐이다 — 루프는 레코더의 존재를 몰라야 한다. 기록 실패는 경기를
 * 중단시키지 않는다: spool 한도를 넘거나 저장이 실패하면 `abort`하고 그 경기의 리플레이를
 * 포기한다. 경기가 리플레이보다 우선한다.
 */

import type { ReplayHandleInfo } from 'shared';
import { buildReplayContainer, nodeReplayCodec, REPLAY_FORMAT_VERSION, type ChunkAccumulator, type ReplayEvent, type ReplayManifest } from './format';
import type { ReplayStore } from './replay-store';

export type { ReplayEvent } from './format';

export interface ReplayMeta {
    matchId: string;
    mapId: string;
    snapshotHz: number;
    startTick: number;
    buildId: string;
    protocolVersion: number;
    rulesVersion: string;
    mapBundleHash: string;
    visibilityCoreVersion: number;
    participants: { playerId: number; nickname: string; colorIndex: number; guest: boolean }[];
}

export interface ReplayOutcome {
    endTick: number;
}

export interface ReplayRecorder {
    /** 게임 시작 시 1회. manifest에 들어갈 값을 고정한다. */
    begin(meta: ReplayMeta): void;
    /** 스냅샷 tick마다. frame은 이미 인코딩된 권위 스냅샷 바이트다. */
    writeFrame(tick: number, frame: Uint8Array, full: boolean): void;
    /** Visibility record: one byte per viewer slot (playerId - 1), always 8 bytes. */
    writeVisibility(tick: number, masks: Uint8Array): void;
    /** JSON 이벤트를 tick과 함께. */
    writeEvent(tick: number, event: ReplayEvent): void;
    /** 경기 종료. 남은 chunk를 닫고 manifest를 완성한다. */
    finish(outcome: ReplayOutcome): Promise<ReplayHandleInfo | null>;
    /** 기록을 버린다. 메모리를 즉시 해제한다. */
    abort(reason: string): void;
}

/** 리플레이가 꺼져 있을 때 쓰는 소비자. 모든 호출이 무비용이다. */
export class NullReplayRecorder implements ReplayRecorder {
    begin(): void {}
    writeFrame(): void {}
    writeVisibility(): void {}
    writeEvent(): void {}
    async finish(): Promise<null> {
        return null;
    }
    abort(): void {}
}

/** 프로세스 전체 메모리 상한. 여러 경기가 동시에 기록될 때 OOM을 막는다. */
const PROCESS_SPOOL_LIMIT_BYTES = 256 * 1024 * 1024;
/** 경기 하나의 상한(프레임 수). 실제 경기는 5분 안팎이라 30Hz 기준 20분이면 충분히 넉넉하다. */
const MATCH_FRAME_LIMIT = 20 * 60 * 30;

/** 여러 `MemoryReplayRecorder` 인스턴스가 공유하는 spool 예산. */
let processSpoolBytes = 0;

export interface MemoryReplayRecorderOptions {
    readonly store: ReplayStore;
    readonly storageKeyFor?: (matchId: string) => string;
    /** 시야 bitmask 기록. 용량과 조사 정확도의 교환이라 끌 수 있게 둔다. */
    readonly recordVisibility?: boolean;
}

/**
 * 경기를 메모리에 통째로 쌓았다가 끝날 때 한 번에 저장소에 쓴다.
 *
 * 5분 경기 원본이 약 1MB라 스트리밍할 이유가 없다. `docs/REPLAY.md` 4절의 "압축과 파일 쓰기는
 * 비동기로 넘긴다"는 tick마다가 아니라 `finish()` 한 번에 한정된다 — 그게 게임 루프 밖이다.
 */
export class MemoryReplayRecorder implements ReplayRecorder {
    readonly #store: ReplayStore;
    readonly #storageKeyFor: (matchId: string) => string;
    readonly #recordVisibility: boolean;

    #meta: ReplayMeta | null = null;
    #chunks: ChunkAccumulator[] = [];
    #current: ChunkAccumulator = { frames: [], visibilities: [], events: [] };
    #frameCount = 0;
    #spooledBytes = 0;
    #aborted = false;
    #finished = false;

    constructor(options: MemoryReplayRecorderOptions) {
        this.#store = options.store;
        this.#storageKeyFor = options.storageKeyFor ?? ((matchId) => `${matchId}.swrp`);
        this.#recordVisibility = options.recordVisibility ?? true;
    }

    begin(meta: ReplayMeta): void {
        this.#meta = meta;
    }

    writeFrame(tick: number, frame: Uint8Array, full: boolean): void {
        if (this.#aborted || this.#finished || this.#meta === null) return;
        if (full && this.#current.frames.length > 0) this.#rotateChunk();

        if (this.#frameCount >= MATCH_FRAME_LIMIT) {
            this.abort(`match frame limit exceeded (${MATCH_FRAME_LIMIT})`);
            return;
        }
        if (processSpoolBytes + frame.byteLength > PROCESS_SPOOL_LIMIT_BYTES) {
            this.abort('process spool limit exceeded');
            return;
        }

        this.#current.frames.push({ tick, full, bytes: frame });
        this.#frameCount += 1;
        this.#spooledBytes += frame.byteLength;
        processSpoolBytes += frame.byteLength;
    }

    writeVisibility(tick: number, masks: Uint8Array): void {
        if (this.#aborted || this.#finished || !this.#recordVisibility) return;
        this.#current.visibilities.push({ tick, masks });
    }

    writeEvent(tick: number, event: ReplayEvent): void {
        if (this.#aborted || this.#finished) return;
        this.#current.events.push({ tick, event });
    }

    async finish(outcome: ReplayOutcome): Promise<ReplayHandleInfo | null> {
        if (this.#aborted || this.#finished || this.#meta === null) {
            this.#release();
            return null;
        }
        this.#finished = true;

        if (this.#current.frames.length > 0 || this.#current.visibilities.length > 0 || this.#current.events.length > 0) {
            this.#chunks.push(this.#current);
        }
        if (this.#chunks.length === 0) {
            this.#release();
            return null;
        }

        const manifestBase: Omit<ReplayManifest, 'chunkCount' | 'rootHash'> = {
            replayFormatVersion: REPLAY_FORMAT_VERSION,
            matchId: this.#meta.matchId,
            mapId: this.#meta.mapId,
            snapshotHz: this.#meta.snapshotHz,
            startTick: this.#meta.startTick,
            endTick: outcome.endTick,
            durationTicks: outcome.endTick - this.#meta.startTick,
            buildId: this.#meta.buildId,
            protocolVersion: this.#meta.protocolVersion,
            rulesVersion: this.#meta.rulesVersion,
            mapBundleHash: this.#meta.mapBundleHash,
            visibilityCoreVersion: this.#meta.visibilityCoreVersion,
            participants: this.#meta.participants,
            // 파일을 남에게 주는 순간, 언제 경기인지를 파일 밖에서 알 방법이 없다.
            recordedAt: Date.now(),
        };

        try {
            const container = await buildReplayContainer(manifestBase, this.#chunks, nodeReplayCodec);
            const storageKey = this.#storageKeyFor(this.#meta.matchId);
            await this.#store.put(storageKey, container.bytes);
            const handle: ReplayHandleInfo = {
                storageKey,
                formatVersion: REPLAY_FORMAT_VERSION,
                chunkCount: container.chunkCount,
                sizeBytes: container.sizeBytes,
                rootHash: container.rootHash,
            };
            this.#release();
            return handle;
        } catch (error) {
            console.error(`[replay] 기록 실패, 이 경기의 리플레이를 포기한다: ${String(error)}`);
            this.#release();
            return null;
        }
    }

    abort(reason: string): void {
        if (this.#aborted || this.#finished) return;
        this.#aborted = true;
        console.warn(`[replay] 기록 중단: ${reason}`);
        this.#release();
    }

    #rotateChunk(): void {
        this.#chunks.push(this.#current);
        this.#current = { frames: [], visibilities: [], events: [] };
    }

    #release(): void {
        processSpoolBytes = Math.max(0, processSpoolBytes - this.#spooledBytes);
        this.#spooledBytes = 0;
        this.#chunks = [];
        this.#current = { frames: [], visibilities: [], events: [] };
    }
}
