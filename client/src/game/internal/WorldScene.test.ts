import { describe, expect, it, vi } from 'vitest';
import type { Snapshot, SnapshotPlayer } from 'shared';

vi.mock('phaser', () => ({ default: {
    Scene: class {
        cameras = { main: { startFollow: vi.fn(), stopFollow: vi.fn() } };
    },
    Math: { Clamp: (value: number, min: number, max: number) => Math.min(max, Math.max(min, value)) },
} }));
vi.mock('./PlayerSprite.ts', () => ({ PlayerSprite: class {
    state = { effects: {}, isTagger: false, isSelf: false };
    followTarget = {};
    destroy = vi.fn();
} }));

import { WorldScene } from './WorldScene.ts';

const player = (id: number, isTagger = false): SnapshotPlayer => ({ id, isTagger, x: 10, y: 20, facingX: 1, facingY: 0, colorIndex: 0, obscured: false, effects: {} });
const snapshot = (players: SnapshotPlayer[]): Snapshot => ({ version: 1, full: false, tick: 1, players });

/** 카메라 맞추기는 Phaser 카메라의 크기·경계·scroll만 본다. 그만큼만 흉내 낸다. */
function withViewport(scene: WorldScene, width: number, height: number): WorldScene {
    Object.assign(scene, { scale: { width, height } });
    Object.assign(scene.cameras.main, {
        width, height, scrollX: 0, scrollY: 0, useBounds: true,
        centerOn: vi.fn(), getBounds: () => ({ width: 1200, height: 1200 }),
    });
    return scene;
}

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

    it('drops camera bounds only while a fitted view is wider than them, and restores them for follow', () => {
        const scene = withViewport(new WorldScene(), 1000, 500);
        // 맵 전체(경계 1200×1200)를 1000×500 화면에 맞추면 화면이 경계보다 넓어진다.
        scene.fitRectToView(0, 0, 1000, 1000, 100);
        expect(scene.cameras.main.useBounds).toBe(false);
        expect(scene.cameras.main.centerOn).toHaveBeenLastCalledWith(500, 500);
        // 도움말 데모처럼 일부만 비추면 경계가 가장자리를 계속 막는다.
        scene.fitRectToView(0, 0, 200, 100);
        expect(scene.cameras.main.useBounds).toBe(true);
        scene.fitRectToView(0, 0, 1000, 1000, 100);
        scene.cameraFollow(1);
        expect(scene.cameras.main.useBounds).toBe(true);
    });

    it('refits after the canvas resizes, and keeps the free-camera center otherwise', () => {
        const scene = withViewport(new WorldScene(), 1000, 500);
        const resize = (width: number, height: number) => {
            Object.assign(scene.scale, { width, height });
            Object.assign(scene.cameras.main, { width, height });
            (scene as unknown as { handleViewportResize(): void }).handleViewportResize();
        };
        scene.fitRectToView(0, 0, 1000, 1000);
        resize(1600, 900);
        // 맞춘 상태면 새 크기로 다시 맞춘다 — 줌이 새 높이를 따라가야 한다.
        expect(scene.getCameraZoom()).toBeCloseTo(0.9);
        expect(scene.cameras.main.centerOn).toHaveBeenLastCalledWith(500, 500);

        scene.cameraCenterOn(300, 300);
        Object.assign(scene.cameras.main, { scrollX: 0, scrollY: 0 });
        resize(1000, 500);
        // 자유 카메라는 Phaser처럼 scroll을 그대로 두지 않고 보던 가운데를 지킨다.
        expect(scene.cameras.main.scrollX).toBe(300);
        expect(scene.cameras.main.scrollY).toBe(200);
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
