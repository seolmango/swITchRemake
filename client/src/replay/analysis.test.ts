import { describe, expect, it } from 'vitest';
import { packVisibleMask, type RecordedEvent, type RecordedFrame, type SnapshotPlayer } from 'shared';
import { buildReplayAnalysis, formatReplayTime } from './analysis.ts';

type P = Partial<SnapshotPlayer> & { id: number; x: number; y: number };
const player = (p: P): SnapshotPlayer => ({
    facingX: 1, facingY: 0, colorIndex: p.id - 1, obscured: false, isTagger: false, effects: {}, ...p,
});

/** 프레임마다 사람 목록을 그대로 돌려주는 가짜 디코더. 바이트 형식과 무관하게 규칙만 본다. */
function build(frames: { tick: number; players?: P[] }[], events: RecordedEvent[] = [], masks: Record<number, number[][]> = {}) {
    const recorded: RecordedFrame[] = frames.map((f, i) => ({ tick: f.tick, full: i === 0, bytes: new Uint8Array([i]) }));
    const byIndex = new Map(recorded.map((frame, i) => [frame, frames[i]!]));
    const visibilities = Object.entries(masks).map(([tick, perViewer]) => {
        const bytes = new Uint8Array(8);
        perViewer.forEach((seen, slot) => { bytes[slot] = packVisibleMask(seen.map((id) => id - 1)); });
        return { tick: Number(tick), masks: bytes };
    });
    return buildReplayAnalysis({
        manifest: {
            startTick: frames[0]?.tick ?? 0,
            endTick: frames.at(-1)?.tick ?? 0,
            participants: [1, 2, 3].map((id) => ({ playerId: id, nickname: `p${id}`, colorIndex: id - 1, guest: false })),
        },
        frames: recorded,
        events,
        visibilities,
        decode: (frame) => {
            const source = byIndex.get(frame)!;
            return source.players ? { players: source.players.map(player) } : {};
        },
    });
}

describe('replay analysis', () => {
    it('turns a switch circle plus its tag into one successful switch with the displaced tagger', () => {
        const a = build([
            { tick: 0, players: [{ id: 1, x: 0, y: 0, isTagger: true }, { id: 2, x: 10, y: 0 }, { id: 3, x: 500, y: 0 }] },
            { tick: 2, players: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 10, y: 0 }, { id: 3, x: 500, y: 0, isTagger: true }] },
        ], [
            { tick: 1, event: { kind: 'skillArea', skillId: 'switch', playerId: 2, fromX: 10, fromY: 0, targetPlayerId: 3 } },
            { tick: 1, event: { kind: 'tagged', playerId: 3, by: 2 } },
        ]);
        const switches = a.events.filter((e) => e.kind === 'switch');
        expect(switches).toEqual([expect.objectContaining({ actorId: 2, targetId: 3, previousTaggerId: 1, frameIndex: 1 })]);
        // 같은 tick의 tagged는 스위치에 흡수되어 따로 "술래로 정해짐"이 되지 않는다.
        expect(a.events.some((e) => e.kind === 'taggerAssigned')).toBe(false);
        expect(a.totalsAt(1).get(2)).toMatchObject({ switchTry: 1, switchSuccess: 1 });
        expect(a.taggerSegments.map((s) => [s.playerId, s.startFrame, s.endFrame])).toEqual([[1, 0, 1], [3, 1, 2]]);
    });

    it('keeps a missed switch as a try, and a tag without a caster as the starting tagger', () => {
        const a = build([
            { tick: 0, players: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 10, y: 0 }] },
            { tick: 2, players: [{ id: 1, x: 0, y: 0, isTagger: true }, { id: 2, x: 10, y: 0 }] },
        ], [
            { tick: 1, event: { kind: 'tagged', playerId: 1 } },
            { tick: 2, event: { kind: 'skillArea', skillId: 'switch', playerId: 2, fromX: 10, fromY: 0, targetPlayerId: 3 } },
        ]);
        expect(a.events.map((e) => e.kind)).toEqual(['taggerAssigned', 'switchMiss']);
        expect(a.totalsAt(1).get(2)).toMatchObject({ switchTry: 1, switchSuccess: 0 });
    });

    it('counts eliminations only up to the playhead and records where and by whom', () => {
        const a = build([
            { tick: 0, players: [{ id: 1, x: 0, y: 0, isTagger: true }, { id: 2, x: 100, y: 50 }] },
            { tick: 2, players: [{ id: 1, x: 90, y: 50, isTagger: true }, { id: 2, x: 100, y: 50 }] },
            { tick: 4, players: [{ id: 1, x: 100, y: 50, isTagger: true }] },
        ], [{ tick: 3, event: { kind: 'eliminated', playerId: 2, by: 1 } }]);
        expect(a.totalsAt(1).get(1)!.eliminations).toBe(0);
        expect(a.totalsAt(1).get(2)!.alive).toBe(true);
        expect(a.totalsAt(2).get(1)!.eliminations).toBe(1);
        expect(a.totalsAt(2).get(2)).toMatchObject({ alive: false, eliminatedAtTick: 3, eliminatedBy: 1 });
        expect(a.events.find((e) => e.kind === 'elimination')).toMatchObject({ x: 100, y: 50, frameIndex: 2 });
    });

    it('derives dash from the effect turning on and finds exhaust victims from new exhaust effects', () => {
        const a = build([
            { tick: 0, players: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 10, y: 0, effects: { exhaust: 0.5 } }, { id: 3, x: 20, y: 0 }] },
            { tick: 2, players: [{ id: 1, x: 0, y: 0, effects: { dash: 1, exhaust: 1 } }, { id: 2, x: 10, y: 0, effects: { exhaust: 1 } }, { id: 3, x: 20, y: 0, effects: { exhaust: 1 } }] },
            { tick: 4, players: [{ id: 1, x: 0, y: 0, effects: { dash: 1 } }, { id: 2, x: 10, y: 0 }, { id: 3, x: 20, y: 0 }] },
        ], [{ tick: 1, event: { kind: 'skillArea', skillId: 'exhaust', playerId: 1, fromX: 0, fromY: 0 } }]);
        expect(a.events.filter((e) => e.kind === 'dash')).toHaveLength(1);
        // 2는 이미 탈진 중이라 이번에 맞았는지 알 수 없다. 시전자 자신의 감속도 적중이 아니다.
        expect(a.events.find((e) => e.kind === 'exhaust')!.exhaustHits).toEqual([3]);
        expect(a.totalsAt(2).get(1)).toMatchObject({ dash: 1, exhaust: 1, exhaustHits: 1 });
    });

    it('measures walked distance and tagger time, skipping the flash jump', () => {
        const a = build([
            { tick: 0, players: [{ id: 1, x: 0, y: 0, isTagger: true }] },
            { tick: 60, players: [{ id: 1, x: 30, y: 40, isTagger: true }] },
            { tick: 120, players: [{ id: 1, x: 1030, y: 40 }] },
        ], [{ tick: 100, event: { kind: 'blinked', playerId: 1, fromX: 30, fromY: 40 } }]);
        const totals = a.totalsAt(2).get(1)!;
        expect(totals.distancePx).toBe(50);
        expect(totals.taggerTicks).toBe(120);
        // 점멸 구간은 동선에서 끊긴다.
        expect(a.pathOf(1, 2)).toEqual([{ x: 0, y: 0 }, { x: 30, y: 40 }, null, { x: 1030, y: 40 }]);
    });

    it('carries players through delta frames without a player list', () => {
        const a = build([
            { tick: 0, players: [{ id: 1, x: 5, y: 5 }] },
            { tick: 2 },
        ]);
        expect(a.states[1]!.players).toEqual(a.states[0]!.players);
    });

    it('answers what a player could see from the recorded masks, and gives up once they are out', () => {
        const a = build([
            { tick: 0, players: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 10, y: 0 }, { id: 3, x: 900, y: 0 }] },
            { tick: 2, players: [{ id: 2, x: 10, y: 0 }, { id: 3, x: 900, y: 0 }] },
        ], [], { 0: [[2], [1], []], 2: [[], [], []] });
        expect([...a.visibleTo(1, 0)!].sort()).toEqual([1, 2]);
        expect([...a.visibleTo(3, 0)!]).toEqual([3]);
        // 탈락한 사람은 관전자라 전부 본다 — 화면은 null을 받고 필터를 걷는다.
        expect(a.visibleTo(1, 1)).toBeNull();
    });

    it('formats replay time to a tenth of a second', () => {
        expect(formatReplayTime(0, 60)).toBe('0:00.0');
        expect(formatReplayTime(60 * 75 + 30, 60)).toBe('1:15.5');
        expect(formatReplayTime(10, null)).toBe('–');
    });
});
