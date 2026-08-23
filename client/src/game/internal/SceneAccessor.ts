import type { WorldScene } from './WorldScene.ts';

/**
 * The only thing the public facade classes (SwitchEngine/MapController/PlayerHandle) are handed —
 * never the WorldScene or a raw Phaser object directly. Calls queue automatically until the scene
 * has booted, so `new SwitchEngine(...)` followed immediately by `engine.spawnPlayer(...)` is safe.
 */
export interface SceneAccessor {
    withScene(fn: (scene: WorldScene) => void): void;
    readScene<T>(fn: (scene: WorldScene) => T, fallback: T): T;
}
