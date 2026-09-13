import { describe, expect, it, vi } from 'vitest';
import type { Snapshot, SnapshotPlayer } from 'shared';

vi.mock('phaser', () => ({ default: { Scene: class {
    cameras = { main: { startFollow: vi.fn(), stopFollow: vi.fn() } };
} } }));
vi.mock('./PlayerSprite.ts', () => ({ PlayerSprite: class {
    state = { effects: {}, isTagger: false, isSelf: false };
    followTarget = {};
    destroy = vi.fn();
} }));

import { WorldScene } from './WorldScene.ts';

const player = (id: number, isTagger = false): SnapshotPlayer => ({ id, isTagger, x: 10, y: 20, facingX: 1, facingY: 0, colorIndex: 0, obscured: false, effects: {} });
const snapshot = (players: SnapshotPlayer[]): Snapshot => ({ version: 1, full: false, tick: 1, players });

describe('world snapshot role and respawn camera', () => {
    it('renders all authoritative tagger flags, including clearing and repeated snapshots', () => {
        const scene = new WorldScene();
        scene.applySnapshot(snapshot([player(1, true), player(2, true)]));
        expect(scene.getPlayerState(1)?.isTagger).toBe(true);
        expect(scene.getPlayerState(2)?.isTagger).toBe(true);
        scene.applySnapshot(snapshot([player(1, true), player(2, true)]));
        expect(scene.getPlayerState(1)?.isTagger).toBe(true);
        expect(scene.getPlayerState(2)?.isTagger).toBe(true);
        scene.applySnapshot(snapshot([player(1, false), player(2, false)]));
        expect(scene.getPlayerState(1)?.isTagger).toBe(false);
        expect(scene.getPlayerState(2)?.isTagger).toBe(false);
    });

    it('follows a requested absent player when the respawn snapshot arrives', () => {
        const scene = new WorldScene();
        scene.cameraFree();
        scene.cameraFollow(1);
        expect(scene.cameras.main.startFollow).not.toHaveBeenCalled();
        scene.applySnapshot(snapshot([player(1)]));
        expect(scene.cameras.main.startFollow).toHaveBeenCalledTimes(1);
        expect(scene.isCameraFree()).toBe(false);
        scene.applySnapshot(snapshot([]));
        scene.applySnapshot(snapshot([player(1)]));
        expect(scene.cameras.main.startFollow).toHaveBeenCalledTimes(2);
    });

    it('does not revive pending follow after the caller explicitly selects free camera', () => {
        const scene = new WorldScene();
        scene.setSelf(1);
        scene.cameraFollow(1);
        scene.cameraFree();
        scene.applySnapshot(snapshot([player(1)]));
        expect(scene.cameras.main.startFollow).not.toHaveBeenCalled();
        expect(scene.isCameraFree()).toBe(true);
    });
});
