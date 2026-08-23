import type { SceneAccessor } from './internal/SceneAccessor.ts';
import type { FloorVariant, MapView, RegionInfo, StormRect, TilePhysics } from './types.ts';

/** Obtained via `engine.map` — never constructed directly. */
export class MapController {
    private readonly scene: SceneAccessor;

    /** @internal constructed by SwitchEngine only. */
    constructor(scene: SceneAccessor) {
        this.scene = scene;
    }

    load(view: MapView): void {
        this.scene.withScene((s) => s.loadMap(view));
    }

    /** Applies one tile's physics change (e.g. the storm destroying a wall/gas tile this tick). */
    setTile(x: number, y: number, physics: TilePhysics): void {
        this.scene.withScene((s) => s.setTile(x, y, physics));
    }

    /** Same as `setTile`, batched — use this when a single tick changes many tiles at once (real storm timelines do). */
    setTiles(changes: readonly { x: number; y: number; physics: TilePhysics }[]): void {
        this.scene.withScene((s) => s.setTiles(changes));
    }

    setFloorVariant(variant: FloorVariant): void {
        this.scene.withScene((s) => s.setFloorVariant(variant));
    }

    /** The current safe-zone rectangle, in world px. Pass `null` while no storm is active. */
    setStormRect(rect: StormRect | null): void {
        this.scene.withScene((s) => s.setStormRect(rect));
    }

    /**
     * Per-tile opacity for concealment (bush/gas) tiles — the whole see-through set at once, replacing
     * whatever was set before. Tiles you don't list render fully opaque, so only send the exceptions
     * (the handful around the viewer). Nothing here is derived by the renderer; this is the caller's
     * vision model made visible.
     */
    setTileAlphas(overrides: readonly { x: number; y: number; alpha: number }[]): void {
        this.scene.withScene((s) => s.setTileAlphas(overrides));
    }

    /** Gas/smoke tile clusters, flood-filled from the loaded map — address these by `id` for setRegionRemaining. */
    getRegions(): RegionInfo[] {
        return this.scene.readScene((s) => s.getRegions(), []);
    }

    /** 1 = fully concealing, 0 = fully dissipated (matching bush tiles have no such concept — they're permanent). */
    setRegionRemaining(id: string, remaining: number): void {
        this.scene.withScene((s) => s.setRegionRemaining(id, remaining));
    }
}
