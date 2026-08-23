import Phaser from 'phaser';
import { MapLayer } from './MapLayer.ts';
import { PlayerSprite, type PlayerVisualState } from './PlayerSprite.ts';
import { BlinkFxLayer } from './BlinkFxLayer.ts';
import { DEFAULT_DISPLAY_OPTIONS, EffectType, type DisplayOptions, type FloorVariant, type MapView, type PlayerInit, type StormRect, type Theme, type TilePhysics } from '../types.ts';
import { Palette } from '../palette.ts';
import { CAMERA, CAMERA_FX, CULL_MARGIN } from '../constants.ts';
import { EMOJI_COUNT, emojiDataUri, emojiTextureKey } from '../emoji.ts';
import { Color } from '../../theme/color.ts';
import { EFFECT_BITS, EventType, type Snapshot } from '../protocol/types.ts';

export interface WorldSceneInit {
    theme: Theme;
    onReady: (scene: WorldScene) => void;
}

/** Emoji SVGs are rasterised once at this size; the pop animation scales the sprite down from here. */
const EMOJI_TEXTURE_PX = 256;

/**
 * The actual Phaser.Scene. Never imported/constructed by consumer code — reached only through
 * `SwitchEngine`/`MapController`/`PlayerHandle`, which is the whole point of the facade split.
 */
export class WorldScene extends Phaser.Scene {
    private clock = 0;
    private theme: Theme = 0;
    private onReadyCb: ((scene: WorldScene) => void) | null = null;

    private mapLayer!: MapLayer;
    private blinkFx!: BlinkFxLayer;
    private readonly players = new Map<number, PlayerSprite>();
    private taggerId: number | null = null;
    private selfId: number | null = null;
    private freeCamera = true;
    private displayOptions: DisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS };
    /** Roster names that arrived before the player was visible — applied when they're first spawned. */
    private readonly pendingNicknames = new Map<number, string>();

    // ---- camera fx state ----
    /** The user/caller-controlled zoom (wheel, `setCameraZoom`) — camera FX multiplies on top of this,
     * never replaces it, so the base value survives concealment/effect zoom coming and going. */
    private baseZoom = 1;
    /** Currently-following target, tracked separately from Phaser's own follow state so per-frame FX can
     * read *that player's* concealed/effects without a lookup back through the camera. Null in free mode. */
    private followedId: number | null = null;
    /** Smoothed product of all active zoom multipliers (concealment/dash/exhaust/frenzy). */
    private fxZoomMult = 1;
    /** One-shot decaying zoom "punch" from the followed player's own blink — separate from `fxZoomMult`
     * since it decays back to 0 (additive), not toward a per-state target. */
    private zoomPunch = 0;

    constructor() {
        super({ key: 'world' });
    }

    init(data: WorldSceneInit): void {
        this.theme = data.theme;
        this.onReadyCb = data.onReady;
    }

    preload(): void {
        // Both themes are baked up front (16 tiny line-art textures) so a theme switch mid-match is a
        // key swap rather than a reload. Loaded as plain images from data URIs — see `emojiDataUri` for
        // why Phaser's own SVG loader can't take these files. Phaser finishes preload before create(),
        // so the queued-ops flush in create() is still safe.
        for (let id = 1; id <= EMOJI_COUNT; id++) {
            for (const theme of [0, 1] as const) {
                const uri = emojiDataUri(id, theme === 1 ? Color.white : Color.black, EMOJI_TEXTURE_PX);
                if (uri) this.load.image(emojiTextureKey(id, theme), uri);
            }
        }
    }

    create(): void {
        this.cameras.main.setBackgroundColor(this.theme === 1 ? Palette.black : Palette.white);
        this.baseZoom = this.cameras.main.zoom;
        this.mapLayer = new MapLayer(this, this.theme);
        this.blinkFx = new BlinkFxLayer(this);
        this.setupCameraInput();
        this.onReadyCb?.(this);
    }

    update(_time: number, delta: number): void {
        const dt = Math.min(delta, 50) / 1000;
        this.clock += dt;

        const view = this.cameras.main.worldView;
        const minX = view.x - CULL_MARGIN, maxX = view.right + CULL_MARGIN;
        const minY = view.y - CULL_MARGIN, maxY = view.bottom + CULL_MARGIN;

        this.mapLayer.update(this.clock, { minX, minY, maxX, maxY });
        this.blinkFx.update(this.clock, this.theme);

        for (const sprite of this.players.values()) {
            const s = sprite.state;
            const onScreen = s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY;
            sprite.update(this.clock, this.theme, onScreen, this.displayOptions);
        }

        this.updateCameraFx(dt);
    }

    /**
     * Purely reactive — reads effect state the caller already pushed into the followed `PlayerSprite`
     * and turns it into camera zoom/lerp/shake. Derives nothing about the world itself (no tile lookups,
     * no concealment), same "dumb renderer" rule as everywhere else in this engine.
     */
    private updateCameraFx(dt: number): void {
        const cam = this.cameras.main;
        const followed = this.followedId !== null ? this.players.get(this.followedId) : undefined;
        const s = followed?.state;

        let targetMult = 1;
        let targetLerp = CAMERA.followLerp;
        if (s) {
            if (s.effects[EffectType.Dash]) {
                targetMult *= CAMERA_FX.dashZoomMult;
                targetLerp = CAMERA_FX.dashLerp;
            }
            if (s.effects[EffectType.Exhaust]) {
                targetMult *= CAMERA_FX.exhaustZoomMult;
                targetLerp = CAMERA_FX.exhaustLerp;
            }
            if (s.effects[EffectType.Frenzy]) {
                targetMult *= CAMERA_FX.frenzyZoomMult;
                // `force=false` (default): only actually (re)starts the shake if it isn't already
                // running, so this re-arms itself just before each short shake ends — continuous tremor
                // for as long as frenzy stays active, and it decays on its own within one duration of
                // frenzy ending without us needing to track or cancel anything.
                cam.shake(CAMERA_FX.frenzyShakeDurationMs, CAMERA_FX.frenzyShakeIntensity);
            }
        }

        const zoomT = 1 - Math.exp(-CAMERA_FX.zoomLerpSpeed * dt);
        this.fxZoomMult = Phaser.Math.Linear(this.fxZoomMult, targetMult, zoomT);
        const punchT = 1 - Math.exp(-CAMERA_FX.blinkPunchDecay * dt);
        this.zoomPunch = Phaser.Math.Linear(this.zoomPunch, 0, punchT);

        cam.zoom = Phaser.Math.Clamp(this.baseZoom * this.fxZoomMult * (1 + this.zoomPunch), CAMERA.minZoom, CAMERA.maxZoom);
        if (!this.freeCamera) cam.setLerp(targetLerp, targetLerp);
    }

    // ---- camera ----
    // Two modes only: free (drag to pan, wheel to zoom) and follow (Phaser's own startFollow, so
    // panning/smoothing is handled by the camera itself rather than us re-centering it every frame).

    private setupCameraInput(): void {
        this.input.on(Phaser.Input.Events.POINTER_MOVE, (pointer: Phaser.Input.Pointer) => {
            if (!this.freeCamera || !pointer.isDown) return;
            const cam = this.cameras.main;
            cam.scrollX -= (pointer.x - pointer.prevPosition.x) / cam.zoom;
            cam.scrollY -= (pointer.y - pointer.prevPosition.y) / cam.zoom;
        });
        this.input.on(
            'wheel',
            (_pointer: Phaser.Input.Pointer, _objects: unknown, _dx: number, dy: number) => {
                if (!this.freeCamera) return;
                const factor = dy > 0 ? 1 - CAMERA.wheelZoomStep : 1 + CAMERA.wheelZoomStep;
                this.baseZoom = Phaser.Math.Clamp(this.baseZoom * factor, CAMERA.minZoom, CAMERA.maxZoom);
            },
        );
    }

    cameraFollow(id: number): void {
        const sprite = this.players.get(id);
        if (!sprite) return;
        this.freeCamera = false;
        this.followedId = id;
        this.cameras.main.startFollow(sprite.followTarget, true, CAMERA.followLerp, CAMERA.followLerp);
    }

    cameraFree(): void {
        this.freeCamera = true;
        this.followedId = null;
        this.cameras.main.stopFollow();
    }

    setCameraZoom(zoom: number): void {
        this.baseZoom = Phaser.Math.Clamp(zoom, CAMERA.minZoom, CAMERA.maxZoom);
    }

    getCameraZoom(): number {
        return this.baseZoom;
    }

    isCameraFree(): boolean {
        return this.freeCamera;
    }

    cameraCenterOn(x: number, y: number): void {
        this.freeCamera = true;
        this.followedId = null;
        this.cameras.main.stopFollow();
        this.cameras.main.centerOn(x, y);
    }

    fitMapToView(paddingPx = 0): void {
        const w = this.mapLayer.worldWidth, h = this.mapLayer.worldHeight;
        if (w <= 0 || h <= 0) return;
        this.freeCamera = true;
        this.followedId = null;
        this.cameras.main.stopFollow();
        this.cameras.main.centerOn(w / 2, h / 2);
        const zoomX = this.scale.width / (w + paddingPx * 2);
        const zoomY = this.scale.height / (h + paddingPx * 2);
        this.baseZoom = Phaser.Math.Clamp(Math.min(zoomX, zoomY), CAMERA.minZoom, CAMERA.maxZoom);
    }

    get now(): number {
        return this.clock;
    }

    get map(): MapLayer {
        return this.mapLayer;
    }

    // ---- theme / camera ----

    setTheme(theme: Theme): void {
        this.theme = theme;
        this.cameras.main.setBackgroundColor(theme === 1 ? Palette.black : Palette.white);
        this.mapLayer.setTheme(theme);
    }

    // ---- map ----

    loadMap(view: MapView): void {
        this.mapLayer.load(view);
        const margin = this.mapLayer.worldMarginPx;
        this.cameras.main.setBounds(-margin, -margin, this.mapLayer.worldWidth + margin * 2, this.mapLayer.worldHeight + margin * 2);
    }

    setTile(x: number, y: number, physics: TilePhysics): void {
        this.mapLayer.setTile(x, y, physics);
    }

    setTiles(changes: readonly { x: number; y: number; physics: TilePhysics }[]): void {
        this.mapLayer.setTiles(changes);
    }

    setFloorVariant(variant: FloorVariant): void {
        this.mapLayer.setFloorVariant(variant);
    }

    setStormRect(rect: StormRect | null): void {
        this.mapLayer.setStormRect(rect);
    }

    setTileAlphas(overrides: readonly { x: number; y: number; alpha: number }[]): void {
        this.mapLayer.setTileAlphas(overrides);
    }

    setRegionRemaining(id: string, remaining: number): void {
        this.mapLayer.setRegionRemaining(id, remaining);
    }

    getRegions() {
        return this.mapLayer.getRegions();
    }

    // ---- players ----

    spawnPlayer(id: number, init: PlayerInit): void {
        let sprite = this.players.get(id);
        if (!sprite) {
            sprite = new PlayerSprite(this);
            this.players.set(id, sprite);
        }
        const s = sprite.state;
        s.x = init.x;
        s.y = init.y;
        s.facingX = init.facingX ?? 0;
        s.facingY = init.facingY ?? 1;
        s.colorIndex = init.colorIndex;
        s.label = init.label ?? String(id + 1);
        s.nickname = init.nickname ?? s.nickname;
        s.isTagger = this.taggerId === id;
        s.isSelf = this.selfId === id;
    }

    removePlayer(id: number): void {
        const sprite = this.players.get(id);
        if (!sprite) return;
        sprite.destroy();
        this.players.delete(id);
        if (this.taggerId === id) this.taggerId = null;
        if (this.selfId === id) this.selfId = null;
    }

    getPlayerState(id: number): PlayerVisualState | undefined {
        return this.players.get(id)?.state;
    }

    hasPlayer(id: number): boolean {
        return this.players.has(id);
    }

    setTagger(id: number | null): void {
        if (this.taggerId !== null) {
            const prev = this.players.get(this.taggerId);
            if (prev) prev.state.isTagger = false;
        }
        this.taggerId = id;
        if (id !== null) {
            const next = this.players.get(id);
            if (next) next.state.isTagger = true;
        }
    }

    setSelf(id: number | null): void {
        if (this.selfId !== null) {
            const prev = this.players.get(this.selfId);
            if (prev) prev.state.isSelf = false;
        }
        this.selfId = id;
        if (id !== null) {
            const next = this.players.get(id);
            if (next) next.state.isSelf = true;
        }
    }

    /**
     * Applies one decoded server frame. This is the only path a real match uses — the individual setters
     * stay for the tutorial and the dev sandbox.
     *
     * The `players` list is authoritative when present: anyone absent from it is removed, because "the
     * server didn't send them" is exactly how invisibility is expressed. Sections that are absent
     * entirely mean "unchanged" and are left alone.
     */
    applySnapshot(snapshot: Snapshot): void {
        if (snapshot.map) {
            this.loadMap({ cols: snapshot.map.cols, rows: snapshot.map.rows, tiles: snapshot.map.tiles });
        }
        if (snapshot.tileChanges?.length) this.setTiles(snapshot.tileChanges);
        if (snapshot.tileAlphas) this.setTileAlphas(snapshot.tileAlphas);
        if (snapshot.storm !== undefined) this.setStormRect(snapshot.storm);
        if (snapshot.selfId !== undefined) this.setSelf(snapshot.selfId);

        if (snapshot.roster) {
            for (const entry of snapshot.roster) {
                const sprite = this.players.get(entry.id);
                if (sprite) sprite.state.nickname = entry.nickname;
                else this.pendingNicknames.set(entry.id, entry.nickname);
            }
        }

        if (snapshot.regions) {
            for (const r of snapshot.regions) this.mapLayer.setRegionRemainingAt(r.x, r.y, r.remaining);
        }

        if (snapshot.players) {
            const seen = new Set<number>();
            let tagger: number | null = null;

            for (const p of snapshot.players) {
                seen.add(p.id);
                if (!this.players.has(p.id)) {
                    this.spawnPlayer(p.id, {
                        x: p.x, y: p.y, colorIndex: p.colorIndex,
                        nickname: this.pendingNicknames.get(p.id) ?? '',
                    });
                    this.pendingNicknames.delete(p.id);
                }
                const s = this.players.get(p.id)!.state;
                s.x = p.x;
                s.y = p.y;
                s.facingX = p.facingX;
                s.facingY = p.facingY;
                s.colorIndex = p.colorIndex;
                s.obscured = p.obscured;
                if (p.isTagger) tagger = p.id;

                for (const key of EFFECT_BITS) {
                    const ratio = p.effects[key];
                    // Ratio is all the bar needs, so `total` is just the unit it's measured against.
                    if (ratio === undefined) delete s.effects[key];
                    else s.effects[key] = { remaining: ratio, total: 1 };
                }

                if (p.emojiId) this.showEmoji(p.id, p.emojiId);
            }

            for (const id of [...this.players.keys()]) {
                if (!seen.has(id)) this.removePlayer(id);
            }
            this.setTagger(tagger);
        }

        if (snapshot.events) {
            for (const e of snapshot.events) {
                if (e.type === EventType.Blink) {
                    const sprite = this.players.get(e.playerId);
                    if (sprite) this.playBlink(e.playerId, e.fromX, e.fromY, sprite.state.x, sprite.state.y);
                }
            }
        }
    }

    setDisplayOptions(options: Partial<DisplayOptions>): void {
        this.displayOptions = { ...this.displayOptions, ...options };
    }

    getDisplayOptions(): DisplayOptions {
        return { ...this.displayOptions };
    }

    showEmoji(id: number, emojiId: number): void {
        this.players.get(id)?.showEmoji(emojiId, this.clock);
    }

    playBlink(id: number, x0: number, y0: number, x1: number, y1: number): void {
        const sprite = this.players.get(id);
        const colorIndex = sprite?.state.colorIndex ?? 0;
        this.blinkFx.play(x0, y0, x1, y1, colorIndex, this.clock);

        if (id === this.followedId) {
            this.zoomPunch = CAMERA_FX.blinkZoomPunch;
            this.cameras.main.flash(CAMERA_FX.blinkFlashDurationMs, 255, 255, 255);
        }
    }
}
