import { describe, expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot, TilePhysics, type Snapshot } from 'shared';
import { BufferedSnapshots } from './BufferedSnapshots.ts';

const frame = (tick: number, fields: Partial<Snapshot> = {}) => encodeSnapshot({ version: 1, full: false, tick, ...fields });

describe('snapshots received while the renderer loads', () => {
    it('preserves the initial map and names while merging later tile mutations', () => {
        const buffer = new BufferedSnapshots();
        const floor = TilePhysics.Floor;
        const wall = TilePhysics.Wall;
        buffer.push(frame(1, { full: true, map: { cols: 2, rows: 1, tiles: [[floor, floor]] }, roster: [{ id: 1, nickname: 'player' }] }));
        buffer.push(frame(2, { tileChanges: [{ x: 0, y: 0, physics: wall }] }));
        buffer.push(frame(3, { tileChanges: [{ x: 1, y: 0, physics: wall }], selfId: 1 }));
        const merged = decodeSnapshot(buffer.take()!);
        expect(merged.tick).toBe(3);
        expect(merged.map?.tiles).toEqual([[wall, wall]]);
        expect(merged.roster).toEqual([{ id: 1, nickname: 'player' }]);
        expect(merged.selfId).toBe(1);
        expect(buffer.take()).toBeNull();
    });

    it('keeps empty authoritative sections and resets on a new match', () => {
        const buffer = new BufferedSnapshots();
        buffer.push(frame(8, { selfId: 1, roster: [{ id: 1, nickname: 'old' }], cooldowns: [{ slot: 0, remainingMs: 100 }] }));
        buffer.push(frame(9, { selfId: 1, cooldowns: [] }));
        expect(decodeSnapshot(buffer.take()!).cooldowns).toEqual([]);
        buffer.push(frame(9, { roster: [{ id: 1, nickname: 'old' }] }));
        buffer.push(frame(1, { full: true, roster: [{ id: 2, nickname: 'new' }] }));
        expect(decodeSnapshot(buffer.take()!).roster).toEqual([{ id: 2, nickname: 'new' }]);
    });
});
