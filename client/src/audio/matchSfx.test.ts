import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomMode, TilePhysics, type Snapshot, type SnapshotPlayer } from 'shared';
const { playSfx } = vi.hoisted(() => ({ playSfx: vi.fn() }));
vi.mock('./sfxPlayer.ts', () => ({ playSfx }));
vi.mock('../game/GameSession.ts', () => ({ gameSession: { getSnapshot: () => ({ lobby: { mode: 'training' } }) } }));
vi.mock('../game/useGameSession.ts', () => ({ useGameSession: vi.fn() }));
import { matchSfx } from './matchSfx.ts';

const player = (id: number, isTagger = false): SnapshotPlayer => ({ id, isTagger, x: 10, y: 10, facingX: 1, facingY: 0, colorIndex: 0, obscured: false, effects: {} });
const frame = (players: SnapshotPlayer[]): Snapshot => ({ version: 1, tick: 1, full: false, players, storm: { x: 0, y: 0, width: 2000, height: 2000 } });

describe('match audio changes', () => {
    beforeEach(() => { matchSfx.reset(); playSfx.mockClear(); vi.restoreAllMocks(); });

    it('keeps repeated training gate and scenery deltas silent', () => {
        matchSfx.onSnapshot({ ...frame([]), map: { cols: 1, rows: 1, tiles: [[TilePhysics.Wall]] } }, null);
        for (let sample = 0; sample < 30; sample++) {
            matchSfx.onSnapshot({ ...frame([]), tileChanges: [{ x: 0, y: 0, physics: sample % 2 ? TilePhysics.Wall : TilePhysics.Floor }] }, null);
        }
        expect(playSfx).not.toHaveBeenCalled();
    });

    it('keeps actual match collapse audio', () => {
        matchSfx.onSnapshot({ ...frame([]), map: { cols: 1, rows: 1, tiles: [[TilePhysics.Wall]] } }, null, RoomMode.Match);
        matchSfx.onSnapshot({ ...frame([]), tileChanges: [{ x: 0, y: 0, physics: TilePhysics.Floor }] }, null, RoomMode.Match);
        expect(playSfx).toHaveBeenCalledExactlyOnceWith('map-collapse');
    });

    it('never pulses a storm warning at the static training boundary', () => {
        let now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        for (let sample = 0; sample < 10; sample++) {
            now += 1300;
            matchSfx.onSnapshot(frame([player(1)]), 1);
        }
        expect(playSfx).not.toHaveBeenCalled();
    });

    it('still warns near an actual match boundary and respects its interval', () => {
        let now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        matchSfx.onSnapshot(frame([player(1)]), 1, RoomMode.Match);
        now = 100;
        matchSfx.onSnapshot(frame([player(1)]), 1, RoomMode.Match);
        expect(playSfx).toHaveBeenCalledTimes(1);
        expect(playSfx).toHaveBeenCalledWith('storm-warn', expect.any(Object));
        now = 1300;
        matchSfx.onSnapshot(frame([player(1)]), 1, RoomMode.Match);
        expect(playSfx).toHaveBeenCalledTimes(2);
    });

    it('does not infer tags from player ordering, visibility, or training role pads', () => {
        matchSfx.onSnapshot(frame([player(1, true), player(2, true)]), null, RoomMode.Match);
        matchSfx.onSnapshot(frame([player(2, true), player(1, true)]), null, RoomMode.Match);
        matchSfx.onSnapshot(frame([player(1, true)]), null, RoomMode.Match);
        matchSfx.onSnapshot(frame([player(2, true)]), null, RoomMode.Match);
        matchSfx.onSnapshot(frame([player(1, true), player(2, false)]), null, RoomMode.Training);
        matchSfx.onSnapshot(frame([player(1, false), player(2, true)]), null, RoomMode.Training);
        expect(playSfx).not.toHaveBeenCalled();
    });

    it('plays one observed match tag transfer, excluding a recent switch', () => {
        vi.spyOn(performance, 'now').mockReturnValue(1000);
        matchSfx.onSnapshot(frame([player(1, true), player(2)]), null, RoomMode.Match);
        matchSfx.onSnapshot(frame([player(1), player(2, true)]), null, RoomMode.Match);
        expect(playSfx).toHaveBeenCalledExactlyOnceWith('tag');
        matchSfx.noteSwitch();
        matchSfx.onSnapshot(frame([player(1, true), player(2)]), null, RoomMode.Match);
        expect(playSfx).toHaveBeenCalledTimes(1);
    });
});
