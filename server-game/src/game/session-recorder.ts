/**
 * `GameSession`과 `ReplayRecorder` 사이. 인코딩 방식과 chunk 경계 판단은 여기서만 한다.
 *
 * 레코더 자체는 tick과 이미 인코딩된 바이트만 안다(`replay/recorder.ts`). "언제 keyframe인지",
 * "이 프레임을 어떻게 인코딩할지"는 게임 루프 쪽 지식이라 여기 둔다.
 */

import { computeVisibility, packVisibleMask, type ReplayHandleInfo } from 'shared';
import { FRAMES_PER_CHUNK } from '../replay/format';
import type { ReplayEvent, ReplayMeta, ReplayOutcome, ReplayRecorder } from '../replay/recorder';
import { toVisibilityWorld, type AuthoritativeFrame, type WorldEvent } from '../simulation/world';
import { encodeForViewer, type RosterEntry, type SnapshotTileChange } from './snapshot-view';

export interface SessionReplayRecorderOptions {
    readonly recorder: ReplayRecorder;
    readonly roster: readonly RosterEntry[];
}

export class SessionReplayRecorder {
    readonly #recorder: ReplayRecorder;
    readonly #roster: readonly RosterEntry[];
    #recordedFrames = 0;

    constructor(options: SessionReplayRecorderOptions) {
        this.#recorder = options.recorder;
        this.#roster = options.roster;
    }

    begin(meta: ReplayMeta): void {
        this.#recorder.begin(meta);
    }

    /** 스냅샷 tick마다. 뷰어에게 보내는 것과 별개로 검열 없는 원본을 기록한다. */
    recordSnapshotTick(frame: AuthoritativeFrame, tileChanges?: readonly SnapshotTileChange[]): void {
        this.#writeFrame(frame, this.#recordedFrames % FRAMES_PER_CHUNK === 0, tileChanges);
    }

    /** 경기 종료 tick. 스냅샷 주기와 정렬되지 않아도 항상 keyframe으로 남긴다. */
    recordFinalFrame(frame: AuthoritativeFrame, tileChanges?: readonly SnapshotTileChange[]): void {
        this.#writeFrame(frame, true, tileChanges);
    }

    /** 이벤트는 시뮬레이션 tick마다. 태그 같은 순간은 스냅샷 주기보다 정밀해야 한다. */
    recordEvents(tick: number, events: readonly WorldEvent[]): void {
        for (const event of events) {
            const replayEvent: ReplayEvent = { kind: event.kind, playerId: event.playerId };
            if (event.by !== undefined) replayEvent.by = event.by;
            if (event.fromX !== undefined) replayEvent.fromX = event.fromX;
            if (event.fromY !== undefined) replayEvent.fromY = event.fromY;
            if (event.slot !== undefined) replayEvent.slot = event.slot;
            this.#recorder.writeEvent(tick, replayEvent);
        }
    }

    finish(outcome: ReplayOutcome): Promise<ReplayHandleInfo | null> {
        return this.#recorder.finish(outcome);
    }

    abort(reason: string): void {
        this.#recorder.abort(reason);
    }

    #writeFrame(frame: AuthoritativeFrame, full: boolean, tileChanges?: readonly SnapshotTileChange[]): void {
        const bytes = new Uint8Array(encodeForViewer(
            frame,
            { playerId: null, access: 'unfiltered', full },
            this.#roster,
            tileChanges,
        ));
        this.#recorder.writeFrame(frame.tick, bytes, full);
        this.#recordedFrames += 1;
        this.#writeVisibility(frame);
    }

    /** One byte per viewer. The mask slots are intentionally zero-based while playerId is one-based. */
    #writeVisibility(frame: AuthoritativeFrame): void {
        const masks = new Uint8Array(8);
        const visibilityWorld = toVisibilityWorld(frame.world);
        for (const entry of this.#roster) {
            const slotIndex = entry.playerId - 1;
            if (slotIndex < 0 || slotIndex >= 8) continue;
            const result = computeVisibility(visibilityWorld, entry.playerId);
            // Visibility masks are a compact zero-based representation, not playerId values.
            masks[slotIndex] = packVisibleMask(result.visiblePlayerIds.map((playerId) => playerId - 1));
        }
        this.#recorder.writeVisibility(frame.tick, masks);
    }
}
