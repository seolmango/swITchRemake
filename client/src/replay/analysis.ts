/**
 * 리플레이 분석 모델. 재생기가 "무슨 일이 언제 누구에게 있었는가"를 답하는 데 쓰는 값을 한 번에 만든다.
 *
 * 화면과 엔진을 모른다 — 녹화된 프레임·사건·시야 마스크만 받아 순수하게 계산한다. 그래서 테스트가
 * 캔버스 없이 돈다. 여기서 만든 값은 모두 **녹화된 사실**에서 나온다. 추측해서 채우는 값은
 * `exhaust`의 맞은 사람처럼 이름에 그렇다고 적는다.
 */
import {
    decodeSnapshot,
    unpackVisibleMask,
    type ReplayManifest,
    type RecordedEvent,
    type RecordedFrame,
    type RecordedVisibility,
    type SnapshotPlayer,
} from 'shared';

export interface PlayerSample {
    id: number;
    x: number;
    y: number;
    isTagger: boolean;
    dash: boolean;
    frenzy: boolean;
    exhaust: boolean;
}

/** 한 프레임 시점에 살아 있는 사람들. 델타 프레임에 사람 목록이 없으면 앞 프레임의 것을 잇는다. */
export interface FrameState {
    tick: number;
    players: readonly PlayerSample[];
}

export type AnalysisEventKind =
    /** 경기 시작이나 강제 교체로 술래가 정해졌다(누가 넘긴 것이 아니다). */
    | 'taggerAssigned'
    /** 술래에게 닿아 탈락했다. actor = 술래, target = 탈락한 사람. */
    | 'elimination'
    /** 스위치 성공. actor = 시전자, target = 새 술래, previousTaggerId = 밀려난 술래. */
    | 'switch'
    /** 스위치를 눌렀지만 사거리 밖이었거나 지목이 틀렸다. target = 노렸던 사람(있으면). */
    | 'switchMiss'
    | 'flash'
    | 'exhaust'
    | 'dash';

export interface AnalysisEvent {
    /** 목록 key와 "지금 사건" 강조에 쓴다. 시간순 번호다. */
    id: number;
    tick: number;
    /** 이 사건이 처음 보이는 프레임(사건 tick 이후 첫 프레임). */
    frameIndex: number;
    kind: AnalysisEventKind;
    actorId: number;
    targetId?: number;
    previousTaggerId?: number;
    /** 사건이 일어난 자리. 점멸은 출발점이다. */
    x?: number;
    y?: number;
    /** 탈진 직후 탈진 효과가 새로 붙은 사람들. 효과가 켜지는 것을 본 것이라 시전자의 자기 감속은 뺀다. */
    exhaustHits?: readonly number[];
}

export interface TaggerSegment {
    playerId: number;
    startFrame: number;
    /** 포함하지 않는다. */
    endFrame: number;
    startTick: number;
    endTick: number;
}

export interface PlayerTotals {
    eliminations: number;
    switchTry: number;
    switchSuccess: number;
    flash: number;
    dash: number;
    exhaust: number;
    exhaustHits: number;
    /** 술래였던 시간(tick). */
    taggerTicks: number;
    /** 이동 거리(px). 점멸로 건너뛴 거리는 빼고 걸어서 움직인 거리만 센다. */
    distancePx: number;
    alive: boolean;
    eliminatedAtTick: number | null;
    eliminatedBy: number | null;
}

export interface ReplayAnalysis {
    readonly startTick: number;
    readonly endTick: number;
    readonly ticks: readonly number[];
    readonly states: readonly FrameState[];
    readonly events: readonly AnalysisEvent[];
    readonly taggerSegments: readonly TaggerSegment[];
    readonly participantIds: readonly number[];
    /** tick 이하의 마지막 프레임. 처음보다 앞이면 0이다. */
    frameAtTick(tick: number): number;
    /** 그 프레임까지 쌓인 사람별 기록. */
    totalsAt(frameIndex: number): ReadonlyMap<number, PlayerTotals>;
    /**
     * 그 프레임에 `viewerId`의 화면에 보였던 사람들(본인 포함). 녹화에 시야가 없으면 null.
     * 탈락한 사람은 관전자가 되어 전부 보므로 null을 돌려준다 — 화면이 전체 시야를 쓰면 된다.
     */
    visibleTo(viewerId: number, frameIndex: number): ReadonlySet<number> | null;
    /** 그 사람이 지나간 자리. 미니맵 동선에 쓴다. 점멸 구간은 끊어서(null) 돌려준다. */
    pathOf(playerId: number, untilFrame: number): readonly ({ x: number; y: number } | null)[];
}

export interface AnalysisInput {
    manifest: Pick<ReplayManifest, 'startTick' | 'endTick' | 'participants'>;
    frames: readonly RecordedFrame[];
    events: readonly RecordedEvent[];
    visibilities: readonly RecordedVisibility[];
    /** 프레임 바이트를 스냅샷으로 푸는 함수. 테스트가 바꿔 끼운다. */
    decode?: (frame: RecordedFrame) => { players?: SnapshotPlayer[] };
}

const defaultDecode = (frame: RecordedFrame) => decodeSnapshot(
    frame.bytes.buffer.slice(frame.bytes.byteOffset, frame.bytes.byteOffset + frame.bytes.byteLength) as ArrayBuffer,
);

const toSample = (player: SnapshotPlayer): PlayerSample => ({
    id: player.id,
    x: player.x,
    y: player.y,
    isTagger: player.isTagger,
    dash: (player.effects.dash ?? 0) > 0,
    frenzy: (player.effects.frenzy ?? 0) > 0,
    exhaust: (player.effects.exhaust ?? 0) > 0,
});

/** 정렬된 배열에서 value 이하인 마지막 위치. 없으면 -1. */
function lastAtOrBefore(sorted: readonly number[], value: number): number {
    let lo = 0, hi = sorted.length - 1, found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid]! <= value) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
}

/** 정렬된 배열에서 value 이상인 첫 위치. 없으면 length. */
function firstAtOrAfter(sorted: readonly number[], value: number): number {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid]! < value) lo = mid + 1; else hi = mid;
    }
    return lo;
}

const emptyTotals = (): PlayerTotals => ({
    eliminations: 0, switchTry: 0, switchSuccess: 0, flash: 0, dash: 0, exhaust: 0, exhaustHits: 0,
    taggerTicks: 0, distancePx: 0, alive: true, eliminatedAtTick: null, eliminatedBy: null,
});

export function buildReplayAnalysis(input: AnalysisInput): ReplayAnalysis {
    const decode = input.decode ?? defaultDecode;
    const frames = [...input.frames].sort((a, b) => a.tick - b.tick);
    const ticks = frames.map((frame) => frame.tick);
    const participantIds = input.manifest.participants.map((p) => p.playerId).sort((a, b) => a - b);

    // ── 프레임별 상태 ──
    const states: FrameState[] = [];
    let carried: PlayerSample[] = [];
    for (const frame of frames) {
        const snapshot = decode(frame);
        if (snapshot.players) carried = snapshot.players.map(toSample).sort((a, b) => a.id - b.id);
        states.push({ tick: frame.tick, players: carried });
    }
    const lastFrame = Math.max(0, states.length - 1);
    const frameAtOrAfterTick = (tick: number) => Math.min(lastFrame, firstAtOrAfter(ticks, tick));
    const sampleAt = (frameIndex: number, id: number) => states[frameIndex]?.players.find((p) => p.id === id);

    // ── 사건 ──
    const raw = [...input.events].sort((a, b) => a.tick - b.tick);
    const consumedTags = new Set<RecordedEvent>();
    const events: Omit<AnalysisEvent, 'id'>[] = [];
    const taggerBefore = (tick: number) => {
        const frame = lastAtOrBefore(ticks, tick - 1);
        return frame < 0 ? undefined : states[frame]!.players.find((p) => p.isTagger)?.id;
    };

    for (const record of raw) {
        const { event, tick } = record;
        const frameIndex = frameAtOrAfterTick(tick);
        if (event.kind === 'skillArea' && event.skillId === 'switch') {
            const success = raw.find((other) => other.tick === tick && other.event.kind === 'tagged' && other.event.by === event.playerId);
            if (success) {
                consumedTags.add(success);
                const previousTaggerId = taggerBefore(tick);
                events.push({
                    tick, frameIndex, kind: 'switch', actorId: event.playerId, targetId: success.event.playerId,
                    ...(previousTaggerId === undefined ? {} : { previousTaggerId }),
                    ...(event.fromX === undefined ? {} : { x: event.fromX, y: event.fromY }),
                });
            } else {
                events.push({
                    tick, frameIndex, kind: 'switchMiss', actorId: event.playerId,
                    ...(event.targetPlayerId === undefined ? {} : { targetId: event.targetPlayerId }),
                    ...(event.fromX === undefined ? {} : { x: event.fromX, y: event.fromY }),
                });
            }
        } else if (event.kind === 'skillArea' && event.skillId === 'exhaust') {
            // 효과가 새로 켜진 사람을 본다. 직전에 이미 탈진 중이던 사람은 이번에 맞았는지 알 수 없어 뺀다.
            const before = lastAtOrBefore(ticks, tick - 1);
            const after = frameAtOrAfterTick(tick);
            const hits = (states[after]?.players ?? [])
                .filter((p) => p.id !== event.playerId && p.exhaust && !(before >= 0 && sampleAt(before, p.id)?.exhaust))
                .map((p) => p.id);
            events.push({
                tick, frameIndex, kind: 'exhaust', actorId: event.playerId, exhaustHits: hits,
                ...(event.fromX === undefined ? {} : { x: event.fromX, y: event.fromY }),
            });
        } else if (event.kind === 'blinked') {
            events.push({
                tick, frameIndex, kind: 'flash', actorId: event.playerId,
                ...(event.fromX === undefined ? {} : { x: event.fromX, y: event.fromY }),
            });
        } else if (event.kind === 'eliminated') {
            const victim = sampleAt(Math.max(0, lastAtOrBefore(ticks, tick)), event.playerId);
            events.push({
                tick, frameIndex, kind: 'elimination', actorId: event.by ?? event.playerId, targetId: event.playerId,
                ...(victim ? { x: victim.x, y: victim.y } : {}),
            });
        }
    }
    for (const record of raw) {
        if (record.event.kind !== 'tagged' || consumedTags.has(record)) continue;
        const frameIndex = frameAtOrAfterTick(record.tick);
        if (record.event.by === undefined) {
            events.push({ tick: record.tick, frameIndex, kind: 'taggerAssigned', actorId: record.event.playerId });
        } else {
            // 시전 원이 없는 스위치. 형식상 가능하므로 버리지 않고 성공으로 센다.
            const previousTaggerId = taggerBefore(record.tick);
            events.push({
                tick: record.tick, frameIndex, kind: 'switch', actorId: record.event.by, targetId: record.event.playerId,
                ...(previousTaggerId === undefined ? {} : { previousTaggerId }),
            });
        }
    }
    // 유체화는 사건으로 남지 않는다. 효과가 켜지는 순간을 사건으로 만든다.
    for (let i = 0; i < states.length; i++) {
        for (const player of states[i]!.players) {
            if (!player.dash) continue;
            if (i > 0 && sampleAt(i - 1, player.id)?.dash) continue;
            if (i === 0) continue;
            events.push({ tick: states[i]!.tick, frameIndex: i, kind: 'dash', actorId: player.id, x: player.x, y: player.y });
        }
    }
    const order: Record<AnalysisEventKind, number> = { taggerAssigned: 0, switch: 1, switchMiss: 2, exhaust: 3, flash: 4, dash: 5, elimination: 6 };
    const sortedEvents: AnalysisEvent[] = events
        .sort((a, b) => a.tick - b.tick || order[a.kind] - order[b.kind])
        .map((event, id) => ({ ...event, id }));

    // ── 술래 구간 ──
    const taggerSegments: TaggerSegment[] = [];
    for (let i = 0; i < states.length; i++) {
        const tagger = states[i]!.players.find((p) => p.isTagger)?.id;
        const current = taggerSegments.at(-1);
        if (current && current.playerId === tagger && current.endFrame === i) {
            current.endFrame = i + 1;
            current.endTick = ticks[i + 1] ?? states[i]!.tick;
        } else if (tagger !== undefined) {
            taggerSegments.push({ playerId: tagger, startFrame: i, endFrame: i + 1, startTick: states[i]!.tick, endTick: ticks[i + 1] ?? states[i]!.tick });
        }
    }

    // ── 누적 거리·술래 시간 (프레임마다) ──
    const flashFrames = new Map<number, Set<number>>();
    for (const event of sortedEvents) {
        if (event.kind !== 'flash') continue;
        const set = flashFrames.get(event.frameIndex) ?? new Set<number>();
        set.add(event.actorId);
        flashFrames.set(event.frameIndex, set);
    }
    const distance = new Map<number, Float64Array>();
    const taggerTicks = new Map<number, Float64Array>();
    for (const id of participantIds) {
        distance.set(id, new Float64Array(states.length));
        taggerTicks.set(id, new Float64Array(states.length));
    }
    for (let i = 0; i < states.length; i++) {
        for (const id of participantIds) {
            const d = distance.get(id)!, t = taggerTicks.get(id)!;
            d[i] = i > 0 ? d[i - 1]! : 0;
            t[i] = i > 0 ? t[i - 1]! : 0;
            if (i === 0) continue;
            const now = sampleAt(i, id), prev = sampleAt(i - 1, id);
            if (now && prev && !flashFrames.get(i)?.has(id)) d[i] = d[i]! + Math.hypot(now.x - prev.x, now.y - prev.y);
            if (prev?.isTagger) t[i] = t[i]! + (states[i]!.tick - states[i - 1]!.tick);
        }
    }

    // ── 시야 ──
    const visibilityTicks = [...input.visibilities].sort((a, b) => a.tick - b.tick);
    const visibilityTickList = visibilityTicks.map((v) => v.tick);

    const totalsCache = new Map<number, ReadonlyMap<number, PlayerTotals>>();

    return {
        startTick: input.manifest.startTick,
        endTick: input.manifest.endTick,
        ticks,
        states,
        events: sortedEvents,
        taggerSegments,
        participantIds,
        frameAtTick: (tick) => Math.max(0, lastAtOrBefore(ticks, tick)),
        totalsAt(frameIndex) {
            const index = Math.max(0, Math.min(lastFrame, frameIndex));
            const cached = totalsCache.get(index);
            if (cached) return cached;
            const totals = new Map<number, PlayerTotals>(participantIds.map((id) => [id, emptyTotals()]));
            const tick = states[index]?.tick ?? 0;
            for (const event of sortedEvents) {
                if (event.tick > tick) break;
                const actor = totals.get(event.actorId);
                switch (event.kind) {
                    case 'elimination': {
                        if (actor && event.actorId !== event.targetId) actor.eliminations += 1;
                        const victim = event.targetId === undefined ? undefined : totals.get(event.targetId);
                        if (victim) { victim.alive = false; victim.eliminatedAtTick = event.tick; victim.eliminatedBy = event.actorId; }
                        break;
                    }
                    case 'switch': if (actor) { actor.switchTry += 1; actor.switchSuccess += 1; } break;
                    case 'switchMiss': if (actor) actor.switchTry += 1; break;
                    case 'flash': if (actor) actor.flash += 1; break;
                    case 'dash': if (actor) actor.dash += 1; break;
                    case 'exhaust': if (actor) { actor.exhaust += 1; actor.exhaustHits += event.exhaustHits?.length ?? 0; } break;
                    case 'taggerAssigned': break;
                }
            }
            for (const [id, entry] of totals) {
                entry.distancePx = distance.get(id)?.[index] ?? 0;
                entry.taggerTicks = taggerTicks.get(id)?.[index] ?? 0;
            }
            // 너무 커지지 않게 최근 것만 남긴다. 재생 중에는 바로 앞 프레임이 다시 쓰일 일이 많다.
            if (totalsCache.size > 256) totalsCache.clear();
            totalsCache.set(index, totals);
            return totals;
        },
        visibleTo(viewerId, frameIndex) {
            const state = states[Math.max(0, Math.min(lastFrame, frameIndex))];
            if (!state) return null;
            if (!state.players.some((p) => p.id === viewerId)) return null;
            const at = lastAtOrBefore(visibilityTickList, state.tick);
            const record = at < 0 ? undefined : visibilityTicks[at];
            if (!record) return null;
            const slot = viewerId - 1;
            if (slot < 0 || slot >= record.masks.length) return null;
            const visible = new Set(unpackVisibleMask(record.masks[slot]!).map((s) => s + 1));
            visible.add(viewerId);
            return visible;
        },
        pathOf(playerId, untilFrame) {
            const out: ({ x: number; y: number } | null)[] = [];
            const end = Math.max(0, Math.min(lastFrame, untilFrame));
            for (let i = 0; i <= end; i++) {
                const sample = sampleAt(i, playerId);
                if (!sample) { if (out.at(-1) !== null && out.length > 0) out.push(null); continue; }
                if (flashFrames.get(i)?.has(playerId) && out.length > 0) out.push(null);
                out.push({ x: sample.x, y: sample.y });
            }
            return out;
        },
    };
}

/** tick을 "m:ss.s"로. 분석에서는 0.1초 단위가 필요하다. */
export function formatReplayTime(ticks: number, simulationHz: number | null): string {
    if (simulationHz === null || simulationHz <= 0) return '–';
    const tenths = Math.max(0, Math.floor(ticks / simulationHz * 10));
    const minutes = Math.floor(tenths / 600);
    const seconds = Math.floor(tenths / 10) % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
}
