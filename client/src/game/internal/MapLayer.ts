import Phaser from 'phaser';
import { TilePhysics, type FloorVariant, type MapView, type RegionInfo, type StormRect, type Theme } from '../types.ts';
import { CONCEAL, FLOOR, GRASS, SCALE, SMOKE, STORM, TILE_SIZE, WALL, WORLD_MARGIN_TILES } from '../constants.ts';
import { Palette } from '../palette.ts';
import { traceQuadraticCurve } from './shapes.ts';
import { buildRegions, collectTiles } from './regions.ts';
import { traceOrthogonalRoundedLoop, traceRegionOutlines } from './regionOutline.ts';
import { DEPTH } from './PlayerSprite.ts';

interface SmokeRegionRuntime extends RegionInfo {
    /** 1 = fully present, 0 = fully dissipated. Set by the caller (setRegionRemaining) — no owned timer here. */
    remaining: number;
    /** Outer-boundary loop(s) in world px, computed once from `tiles` — the shape never changes between frames. */
    outlineLoopsPx: readonly (readonly (readonly [number, number])[])[];
    /** World-px bounding box, computed once from `tiles` — lets per-frame redraw skip whole off-screen regions cheaply. */
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** Camera worldView (+ cull margin), in world px — lets per-frame redraws skip generating geometry for
 * anything the camera can't currently see. */
export interface ViewBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

const rectsIntersect = (ax: number, ay: number, aRight: number, aBottom: number, v: ViewBounds): boolean =>
    aRight >= v.minX && ax <= v.maxX && aBottom >= v.minY && ay <= v.maxY;

/** Merged outer boundary of a tile set, in world px. Adjacent tiles share no edge, so a solid patch
 * strokes as one silhouette instead of a grid of individually-outlined squares. */
const outlineLoopsFor = (tiles: readonly (readonly [number, number])[]): (readonly [number, number])[][] =>
    traceRegionOutlines(tiles).map((loop) => loop.map(([x, y]) => [x * TILE_SIZE, y * TILE_SIZE] as const));

/** Clips rect (x,y,w,h) to `view`, or returns null if there's no overlap. */
function intersectRect(x: number, y: number, w: number, h: number, view: ViewBounds): [number, number, number, number] | null {
    const x0 = Math.max(x, view.minX), y0 = Math.max(y, view.minY);
    const x1 = Math.min(x + w, view.maxX), y1 = Math.min(y + h, view.maxY);
    if (x1 <= x0 || y1 <= y0) return null;
    return [x0, y0, x1 - x0, y1 - y0];
}

export class MapLayer {
    private map: MapView | null = null;
    private bushTiles: [number, number][] = [];
    private smokeRegions: Map<string, SmokeRegionRuntime> = new Map();
    /** "x,y" of every gas tile → its region id. Lets the wire format address a region by any one of its
     * tiles instead of shipping a string id the server would have to derive the same way. */
    private tileToRegionId = new Map<string, string>();
    private theme: Theme;
    private floorVariant: FloorVariant = 'default';
    private stormRect: StormRect | null = null;
    /** Per-tile opacity overrides for concealment tiles, keyed "x,y". Absent = fully opaque. The caller
     * (server) owns this entirely — the renderer never derives it from anyone's position. See `setTileAlphas`. */
    private tileAlphas = new Map<string, number>();
    /** Set when `tileAlphas` actually changed, so `update` can bypass the grass/smoke redraw throttle. */
    private concealDirty = false;

    private frameCounter = 0;

    private readonly staticGfx: Phaser.GameObjects.Graphics;
    private readonly stormFillGfx: Phaser.GameObjects.Graphics;
    private readonly stormBorderGfx: Phaser.GameObjects.Graphics;
    private readonly grassGfx: Phaser.GameObjects.Graphics;
    private readonly smokeGfx: Phaser.GameObjects.Graphics;

    constructor(scene: Phaser.Scene, theme: Theme) {
        this.theme = theme;
        this.staticGfx = scene.add.graphics().setDepth(DEPTH.mapStatic);
        this.stormFillGfx = scene.add.graphics().setDepth(DEPTH.stormFill);
        this.stormBorderGfx = scene.add.graphics().setDepth(DEPTH.stormBorder);
        this.grassGfx = scene.add.graphics().setDepth(DEPTH.grass);
        this.smokeGfx = scene.add.graphics().setDepth(DEPTH.smoke);
    }

    get worldWidth(): number {
        return (this.map?.cols ?? 0) * TILE_SIZE;
    }

    get worldHeight(): number {
        return (this.map?.rows ?? 0) * TILE_SIZE;
    }

    get worldMarginPx(): number {
        return WORLD_MARGIN_TILES * TILE_SIZE;
    }

    load(map: MapView): void {
        this.map = map;
        this.bushTiles = collectTiles(map, TilePhysics.Bush);
        const freshRegions = buildRegions(map, TilePhysics.Gas);
        const nextRegions = new Map<string, SmokeRegionRuntime>();
        for (const region of freshRegions) {
            const prev = this.smokeRegions.get(region.id);
            const outlineLoopsPx = traceRegionOutlines(region.tiles).map((loop) => loop.map(([x, y]) => [x * TILE_SIZE, y * TILE_SIZE] as const));
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const [cx, cy] of region.tiles) {
                minX = Math.min(minX, cx * TILE_SIZE);
                minY = Math.min(minY, cy * TILE_SIZE);
                maxX = Math.max(maxX, (cx + 1) * TILE_SIZE);
                maxY = Math.max(maxY, (cy + 1) * TILE_SIZE);
            }
            nextRegions.set(region.id, { ...region, remaining: prev?.remaining ?? 1, outlineLoopsPx, minX, minY, maxX, maxY });
        }
        this.smokeRegions = nextRegions;

        this.tileToRegionId = new Map();
        for (const region of nextRegions.values()) {
            for (const [cx, cy] of region.tiles) this.tileToRegionId.set(`${cx},${cy}`, region.id);
        }

        this.redrawStatic();
    }

    /** Applies one tile change (e.g. the storm destroying a single wall/gas tile). Convenience wrapper over `setTiles`. */
    setTile(x: number, y: number, physics: TilePhysics): void {
        this.setTiles([{ x, y, physics }]);
    }

    /**
     * Applies a batch of tile changes as one rebuild. Real timelines can move dozens of tiles in a
     * single tick near the shrinking boundary (BattleField's tick 2048 touches 62 at once) — batching
     * keeps that one rebuild instead of one per tile. Still a full static-layer rebuild under the hood;
     * if whole-map rebuilds ever show up in profiling, swap the static bake for a RenderTexture and
     * stamp only the changed tiles instead.
     */
    setTiles(changes: readonly { x: number; y: number; physics: TilePhysics }[]): void {
        if (!this.map || changes.length === 0) return;
        const newTiles = this.map.tiles.map((row) => row.slice());
        for (const { x, y, physics } of changes) {
            const row = newTiles[y];
            if (row) row[x] = physics;
        }
        this.load({ ...this.map, tiles: newTiles });
    }

    setTheme(theme: Theme): void {
        this.theme = theme;
        this.redrawStatic();
    }

    setFloorVariant(variant: FloorVariant): void {
        this.floorVariant = variant;
        this.redrawStatic();
    }

    setStormRect(rect: StormRect | null): void {
        this.stormRect = rect;
    }

    /**
     * Replaces the whole per-tile opacity override set for concealment (bush/gas) tiles. Any tile NOT in
     * `overrides` renders fully opaque, so the caller only ever sends the exceptions — in the legacy vision
     * model that's just the handful of tiles near the viewer (measured worst case: 13 tiles on BattleField),
     * which is why full replacement every tick is affordable and no delta protocol is needed.
     *
     * Replacement (not merge) semantics deliberately: a tile dropping out of the set must go back to opaque
     * on its own, otherwise stale see-through patches would trail behind a moving viewer forever.
     *
     * The renderer batches one draw per distinct alpha value, so values are quantised on ingest to bound
     * that batch count no matter what the caller sends.
     */
    setTileAlphas(overrides: readonly { x: number; y: number; alpha: number }[]): void {
        const next = new Map<string, number>();
        for (const { x, y, alpha } of overrides) {
            const clamped = Math.max(0, Math.min(1, alpha));
            next.set(`${x},${y}`, Math.round(clamped * CONCEAL.alphaQuantSteps) / CONCEAL.alphaQuantSteps);
        }
        // Callers are expected to resend the same set every tick while nothing moves, so compare before
        // marking dirty — otherwise the throttle bypass above would fire every single frame.
        const prev = this.tileAlphas;
        let changed = prev.size !== next.size;
        if (!changed) {
            for (const [key, alpha] of next) {
                if (prev.get(key) !== alpha) { changed = true; break; }
            }
        }
        this.tileAlphas = next;
        if (changed) this.concealDirty = true;
    }

    private alphaAt(x: number, y: number): number {
        return this.tileAlphas.get(`${x},${y}`) ?? 1;
    }

    getRegions(): RegionInfo[] {
        return Array.from(this.smokeRegions.values());
    }

    /** 0..1 — how much of a gas region's concealment lifetime is left. Drives its fade + gauge ring. */
    setRegionRemaining(id: string, remaining: number): void {
        const region = this.smokeRegions.get(id);
        if (region) region.remaining = Math.max(0, Math.min(1, remaining));
    }

    /** Same, addressed by any tile belonging to the region — the form the wire protocol uses. */
    setRegionRemainingAt(x: number, y: number, remaining: number): void {
        const id = this.tileToRegionId.get(`${x},${y}`);
        if (id) this.setRegionRemaining(id, remaining);
    }

    /**
     * Per-frame cosmetic animation only (sway, dot shimmer, storm fill drift + border pulse) — no
     * gameplay state changes here. Grass sway / smoke dot-shimmer are throttled to every 3rd frame
     * (~20fps still reads as smooth for slow ambient motion, cuts their cost to a third) since their
     * *shape* only changes on real tile edits, not every frame — but the storm fill can NOT be throttled
     * the same way: unlike grass/smoke, its rect tracks a value (the safe zone) that's typically updated
     * every frame by the caller as the barrier shrinks, so redrawing it on a stale cadence made the fill
     * visibly lag behind the border (which redraws every frame) by up to 2 frames — the two drifted apart
     * instead of tracking the same rect. Storm fill and border both redraw every frame instead.
     *
     * `concealDirty` is the same hazard in miniature: per-tile alphas track the viewer's position, so the
     * throttle is bypassed on any frame they changed rather than letting a see-through patch lag up to two
     * frames behind the player who caused it.
     */
    update(t: number, view: ViewBounds): void {
        this.frameCounter++;
        if (this.frameCounter % 3 === 0 || this.concealDirty) {
            this.concealDirty = false;
            this.redrawGrass(view);
            this.redrawSmoke(view);
        }
        this.redrawStormFill(t, view);
        this.redrawStormBorder(t);
    }

    destroy(): void {
        this.staticGfx.destroy();
        this.stormFillGfx.destroy();
        this.stormBorderGfx.destroy();
        this.grassGfx.destroy();
        this.smokeGfx.destroy();
    }

    private redrawStatic(): void {
        const g = this.staticGfx;
        g.clear();
        const map = this.map;
        if (!map) return;
        const dark = this.theme === 1;
        const w = map.cols * TILE_SIZE, h = map.rows * TILE_SIZE;

        g.fillStyle(dark ? Palette.black : (this.floorVariant === 'light' ? 0xE4F1FF : Palette.blue[0]), 1);
        g.fillRect(0, 0, w, h);

        g.lineStyle(FLOOR.gridLineWidth, dark ? Palette.blue[2] : Palette.white, dark ? 0.22 : (this.floorVariant === 'light' ? 1 : 0.95));
        g.beginPath();
        for (let c = 1; c < map.cols; c++) {
            g.moveTo(c * TILE_SIZE, 0);
            g.lineTo(c * TILE_SIZE, h);
        }
        for (let r = 1; r < map.rows; r++) {
            g.moveTo(0, r * TILE_SIZE);
            g.lineTo(w, r * TILE_SIZE);
        }
        g.strokePath();

        for (let y = 0; y < map.rows; y++) {
            const row = map.tiles[y];
            if (!row) continue;
            for (let x = 0; x < map.cols; x++) {
                if (row[x] !== TilePhysics.Wall) continue;
                const tx = x * TILE_SIZE, ty = y * TILE_SIZE;
                if (!dark) {
                    g.fillStyle(Palette.gray[0], 1);
                    g.fillRect(tx, ty, TILE_SIZE, TILE_SIZE);
                    g.lineStyle(WALL.strokeWidth, Palette.gray[2], 1);
                    g.strokeRect(tx + 1, ty + 1, TILE_SIZE - 2, TILE_SIZE - 2);
                    g.lineStyle(WALL.strokeWidth, Palette.white, 0.9);
                } else {
                    g.lineStyle(WALL.strokeWidth, Palette.gray[2], 0.85);
                    g.strokeRect(tx + 1, ty + 1, TILE_SIZE - 2, TILE_SIZE - 2);
                    g.lineStyle(WALL.strokeWidth, Palette.gray[2], 0.4);
                }
                const off = (y % 2) ? TILE_SIZE / 2 : 0;
                g.beginPath();
                g.moveTo(tx + 2, ty + TILE_SIZE / 2);
                g.lineTo(tx + TILE_SIZE - 2, ty + TILE_SIZE / 2);
                g.moveTo(tx + off + TILE_SIZE / 4, ty + 2);
                g.lineTo(tx + off + TILE_SIZE / 4, ty + TILE_SIZE / 2);
                const thirdX = tx + ((off + TILE_SIZE / 4 + TILE_SIZE / 2) % TILE_SIZE);
                g.moveTo(thirdX, ty + TILE_SIZE / 2);
                g.lineTo(thirdX, ty + TILE_SIZE - 2);
                g.strokePath();
            }
        }
    }

    /**
     * Four bands (top/bottom/left/right) around the safe-zone rect, extended out to the map's margin
     * so the danger zone reads as a visible border from tick 0 instead of a hard cutoff at the map edge.
     * Solid fills abut seamlessly regardless of band boundaries; the dark-mode hatch pattern used to
     * visibly seam at those boundaries because each band restarted its own pattern grid from its own
     * corner — fixed by sampling `drawDiagonalHatch` from one shared world-space grid (see below) instead,
     * which also makes a uniform drift trivial. (Tried an actual GPU geometry-mask hole-punch first, per
     * the original request, but it crashed the WebGL renderer here — Framebuffer status: Incomplete
     * Attachment — so this achieves the same seamless look without touching the mask system.)
     */
    private redrawStormFill(t: number, view: ViewBounds): void {
        const g = this.stormFillGfx;
        g.clear();
        if (!this.map || !this.stormRect) {
            g.setVisible(false);
            return;
        }
        g.setVisible(true);

        const margin = this.worldMarginPx;
        const outerX = -margin, outerY = -margin;
        const outerW = this.worldWidth + margin * 2, outerH = this.worldHeight + margin * 2;
        const { x: zx, y: zy, width: zw, height: zh } = this.stormRect;
        const dark = this.theme === 1;
        const driftY = t * STORM.driftSpeedPerSec;

        const bands: [number, number, number, number][] = [
            [outerX, outerY, outerW, zy - outerY],
            [outerX, zy + zh, outerW, outerY + outerH - (zy + zh)],
            [outerX, zy, zx - outerX, zh],
            [zx + zw, zy, outerX + outerW - (zx + zw), zh],
        ];

        for (const [bx, by, bw, bh] of bands) {
            if (bw <= 0 || bh <= 0) continue;
            if (!dark) {
                g.fillStyle(Palette.red[0], 0.8);
                g.fillRect(bx, by, bw, bh);
                g.fillStyle(Palette.red[1], 0.45);
                g.fillRect(bx, by, bw, bh);
            } else {
                // The flat base fill is one cheap draw call regardless of size, so it always covers the
                // whole band. The hatch pattern below is the expensive part (many line segments), so its
                // grid generation is bounded to the camera's current view — on a large map with a huge
                // danger-zone band, generating the full pattern every frame regardless of what's on screen
                // was the single biggest per-frame cost in the engine.
                g.fillStyle(Palette.red[2], 0.1);
                g.fillRect(bx, by, bw, bh);
                const clip = intersectRect(bx, by, bw, bh, view);
                if (clip) drawDiagonalHatch(g, clip[0], clip[1], clip[2], clip[3], driftY);
            }
        }
    }

    private redrawStormBorder(t: number): void {
        const g = this.stormBorderGfx;
        g.clear();
        if (!this.stormRect) return;
        const dark = this.theme === 1;
        const alpha = 0.75 + Math.sin(t * STORM.pulseSpeed) * 0.25;
        g.lineStyle(dark ? STORM.strokeWidthDark : STORM.strokeWidthLight, Palette.red[2], alpha);
        g.strokeRect(this.stormRect.x, this.stormRect.y, this.stormRect.width, this.stormRect.height);
    }

    /**
     * Tiles sharing an alpha are still unioned into one merged blob (so a solid patch has no internal
     * seams); only differing alphas split into separate batches. Realistically that's two batches — the
     * opaque bulk plus the see-through pocket around the viewer.
     *
     * Each layer's own alpha is multiplied by the tile alpha rather than compositing the finished tile
     * once. Not identical to true group opacity, but monotonic and correct at both ends (at alpha 0 every
     * layer vanishes and the floor shows through), and it avoids needing one Graphics object per distinct
     * alpha just to call `setAlpha` on it.
     */
    private redrawGrass(view: ViewBounds): void {
        const g = this.grassGfx;
        g.clear();
        if (this.bushTiles.length === 0) return;
        const dark = this.theme === 1;

        // Culling to the view is safe even though tiles are merged below: the cull margin puts the
        // resulting cut edge well off-screen, so it never shows as a fake boundary.
        const visibleTiles = this.bushTiles.filter(([cx, cy]) => rectsIntersect(cx * TILE_SIZE, cy * TILE_SIZE, (cx + 1) * TILE_SIZE, (cy + 1) * TILE_SIZE, view));
        if (visibleTiles.length === 0) return;

        for (const [tileAlpha, tiles] of this.groupByAlpha(visibleTiles)) {
            if (tileAlpha <= 0) continue;

            // Traced as one merged boundary per group, the same way smoke is. The old per-tile rounded
            // blobs unioned correctly under fill (nonzero winding) but `strokePath` outlines *every*
            // subpath, including the edges buried inside the union — so a solid patch of grass rendered
            // as a visible grid of separate rounded squares.
            g.beginPath();
            for (const loop of outlineLoopsFor(tiles)) traceOrthogonalRoundedLoop(g, loop, GRASS.blobCornerRadius);

            g.fillStyle(dark ? Palette.grass[2] : Palette.grass[0], (dark ? 0.16 : 1) * tileAlpha);
            g.fillPath();
            if (dark) {
                g.fillStyle(Palette.black, 0.55 * tileAlpha);
                g.fillPath();
            }

            g.lineStyle(GRASS.lineWidth, Palette.grass[2], (dark ? 0.95 : 0.85) * tileAlpha);
            g.beginPath();
            for (const [cx, cy] of tiles) {
                const x = cx * TILE_SIZE, y = cy * TILE_SIZE;
                for (let i = 0; i < GRASS.blades; i++) {
                    const bx = x + GRASS.bladeOffsetX + i * GRASS.bladeStepX + (i % 2 ? GRASS.bladeAltOffsetX : 0);
                    const by = y + TILE_SIZE - GRASS.bladeBottomOffset - (i % 3) * GRASS.bladeBottomStep;
                    traceQuadraticCurve(g, bx, by, bx, by - GRASS.bladeControlY, bx, by - GRASS.bladeHeight);
                }
            }
            g.strokePath();
        }

        // Silhouette last, and only once for the whole patch. Stroking per alpha group instead would ring
        // the see-through pocket with its own outline, reading as a hole cut into the bush rather than as
        // the grass simply thinning out where the viewer is standing.
        g.beginPath();
        for (const loop of outlineLoopsFor(visibleTiles)) traceOrthogonalRoundedLoop(g, loop, GRASS.blobCornerRadius);
        g.lineStyle(GRASS.blobStrokeWidth, dark ? Palette.grass[2] : Palette.grass[1], dark ? 0.7 : 0.9);
        g.strokePath();
    }

    /** Buckets tiles by their per-tile alpha. Alphas are already quantised on ingest, so the bucket count
     * is bounded regardless of what the caller sent. */
    private groupByAlpha(tiles: readonly (readonly [number, number])[]): Map<number, (readonly [number, number])[]> {
        const groups = new Map<number, (readonly [number, number])[]>();
        for (const tile of tiles) {
            const alpha = this.alphaAt(tile[0], tile[1]);
            const bucket = groups.get(alpha);
            if (bucket) bucket.push(tile);
            else groups.set(alpha, [tile]);
        }
        return groups;
    }

    /**
     * Traces the smoke region's actual outer boundary (adjacent gas tiles merge into one silhouette,
     * no internal edges between them) instead of unioning per-tile padded blobs — the earlier approach
     * still stroked each tile's own rounded-rect edge, which showed as faint internal seams within a
     * merged cluster. Padding is gone too (the outline sits exactly on the tile grid) since offsetting
     * an arbitrary orthogonal polygon outward isn't worth the complexity here.
     */
    private redrawSmoke(view: ViewBounds): void {
        const g = this.smokeGfx;
        g.clear();
        const dark = this.theme === 1;

        // Each region is its own independent boundary-traced shape, so skipping whole off-screen
        // regions here (bbox check, computed once in `load()`) is safe — unlike grass tiles there's no
        // per-tile granularity to preserve, so this is a plain filter over regions instead of tiles.
        const regionsInView = [...this.smokeRegions.values()].filter((r) => r.remaining > 0 && rectsIntersect(r.minX, r.minY, r.maxX, r.maxY, view));
        if (regionsInView.length === 0) return;

        // Phaser's WebGL Graphics renderer silently drops the stroke on the very first
        // beginPath/fillPath×N/strokePath cycle issued right after clear() — reproducibly, only the
        // first cycle each frame, regardless of which region/shape it is (confirmed by reversing
        // iteration order: the failure moved to whichever region went first; a degenerate/off-screen
        // warm-up stroke did NOT absorb it, only a real same-geometry one did). So: stroke the first
        // (visible) region's outline once at alpha 0 purely to burn that first cycle before drawing
        // anything visible.
        const firstRegion = regionsInView[0]!;
        g.lineStyle(SMOKE.strokeWidth, dark ? Palette.smoke[1] : Palette.smoke[2], 0);
        g.beginPath();
        for (const loop of firstRegion.outlineLoopsPx) traceOrthogonalRoundedLoop(g, loop, SMOKE.blobCornerRadius);
        g.strokePath();

        for (const region of regionsInView) {
            // Same alpha-bucketing as grass. The whole-region outline is cached, so reuse it whenever the
            // region is uniform (the overwhelmingly common case) and only re-trace when a viewer's
            // see-through pocket actually splits this region into differently-lit parts.
            const groups = this.groupByAlpha(region.tiles);
            for (const [tileAlpha, tiles] of groups) {
                if (tileAlpha <= 0) continue;
                const alpha = region.remaining * tileAlpha;
                const loops = groups.size === 1 ? region.outlineLoopsPx : outlineLoopsFor(tiles);

                g.beginPath();
                for (const loop of loops) traceOrthogonalRoundedLoop(g, loop, SMOKE.blobCornerRadius);

                g.fillStyle(dark ? Palette.black : Palette.smoke[0], dark ? 0.85 * alpha : alpha);
                g.fillPath();
                if (dark) {
                    g.fillStyle(Palette.smoke[1], 0.13 * alpha);
                    g.fillPath();
                }

                g.fillStyle(dark ? Palette.smoke[1] : Palette.smoke[2], (dark ? 0.5 : 0.35) * alpha);
                for (const [cx, cy] of tiles) {
                    const x0 = cx * TILE_SIZE, y0 = cy * TILE_SIZE;
                    for (let dy = SMOKE.dotSpacing / 2; dy < TILE_SIZE; dy += SMOKE.dotSpacing) {
                        for (let dx = SMOKE.dotSpacing / 2; dx < TILE_SIZE; dx += SMOKE.dotSpacing) {
                            g.fillCircle(x0 + dx, y0 + dy, SMOKE.dotRadius);
                        }
                    }
                }
            }

            // Silhouette once per region, not per alpha group — same reason as grass: stroking each
            // group would ring the viewer's see-through pocket with its own outline.
            g.beginPath();
            for (const loop of region.outlineLoopsPx) traceOrthogonalRoundedLoop(g, loop, SMOKE.blobCornerRadius);
            g.lineStyle(SMOKE.strokeWidth, dark ? Palette.smoke[1] : Palette.smoke[2], 0.8 * region.remaining);
            g.strokePath();

            // Lifetime gauge belongs to the region as a whole, so it's drawn once at full strength
            // regardless of how the region got split above.
            const gaugeAlpha = region.remaining;
            g.lineStyle(SMOKE.gaugeWidth, dark ? Palette.smoke[1] : Palette.smoke[2], 0.3);
            g.strokeCircle(region.centerX, region.centerY, SMOKE.gaugeRadius);
            g.lineStyle(SMOKE.gaugeWidth, dark ? Palette.smoke[1] : Palette.smoke[2], 1);
            g.beginPath();
            g.arc(region.centerX, region.centerY, SMOKE.gaugeRadius, -Math.PI / 2, -Math.PI / 2 + gaugeAlpha * Math.PI * 2, false);
            g.strokePath();
        }
    }
}

/**
 * Liang-Barsky line clip: returns the portion of segment (x0,y0)-(x1,y1) inside the [xmin,xmax]x[ymin,ymax]
 * rect, or null if none of it is. Needed because `drawDiagonalHatch`'s segments extend past whichever
 * grid cell "owns" them (up to ~25 demo-px = ~160 world px) — without clipping, hatch strokes bled past
 * a band's true edge into the safe zone, reading as the storm border lagging behind the visible danger
 * texture by about a tile ("한칸 뒤에 외곽선이 따라오는 느낌").
 */
function clipSegmentToRect(x0: number, y0: number, x1: number, y1: number, xmin: number, ymin: number, xmax: number, ymax: number): [number, number, number, number] | null {
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    const checks: [number, number][] = [[-dx, x0 - xmin], [dx, xmax - x0], [-dy, y0 - ymin], [dy, ymax - y0]];
    for (const [p, q] of checks) {
        if (p === 0) {
            if (q < 0) return null;
            continue;
        }
        const r = q / p;
        if (p < 0) {
            if (r > t1) return null;
            if (r > t0) t0 = r;
        } else {
            if (r < t0) return null;
            if (r < t1) t1 = r;
        }
    }
    return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

/**
 * Samples pattern-tile origins from one shared world-space grid (multiples of `step`, offset only by
 * the global drift) rather than starting a fresh grid at each band's own corner — that's what keeps the
 * pattern continuous across band boundaries, since every band is just a different window into the same
 * infinite tiling instead of four independently-phased ones. Every segment is clipped to this band's own
 * (x,y,w,h) — see `clipSegmentToRect` — so nothing bleeds past this band's true edge.
 */
function drawDiagonalHatch(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, driftY: number): void {
    const step = STORM.patternTile;
    g.lineStyle(STORM.hatchLineWidth, Palette.red[2], 0.55);
    g.beginPath();
    const firstCol = Math.floor(x / step) - 1;
    const lastCol = Math.ceil((x + w) / step) + 1;
    const firstRow = Math.floor((y - driftY) / step) - 1;
    const lastRow = Math.ceil((y + h - driftY) / step) + 1;
    const xmax = x + w, ymax = y + h;
    for (let ry = firstRow; ry <= lastRow; ry++) {
        for (let rx = firstCol; rx <= lastCol; rx++) {
            const ox = rx * step, oy = ry * step + driftY;
            const raw: [number, number, number, number][] = [
                [ox - 4 * SCALE, oy + 18 * SCALE, ox + 18 * SCALE, oy - 4 * SCALE],
                [ox - 11 * SCALE, oy + 11 * SCALE, ox + 11 * SCALE, oy - 11 * SCALE],
                [ox + 3 * SCALE, oy + 25 * SCALE, ox + 25 * SCALE, oy + 3 * SCALE],
            ];
            for (const [sx0, sy0, sx1, sy1] of raw) {
                const clipped = clipSegmentToRect(sx0, sy0, sx1, sy1, x, y, xmax, ymax);
                if (!clipped) continue;
                g.moveTo(clipped[0], clipped[1]);
                g.lineTo(clipped[2], clipped[3]);
            }
        }
    }
    g.strokePath();
}
