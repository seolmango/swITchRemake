import Phaser from 'phaser';
import { MapLayer } from './MapLayer.ts';
import { PlayerSprite, type PlayerVisualState } from './PlayerSprite.ts';
import { BlinkFxLayer } from './BlinkFxLayer.ts';
import { SwitchFxLayer } from './SwitchFxLayer.ts';
import { DEFAULT_DISPLAY_OPTIONS, DEFAULT_ENGINE_SETTINGS, EffectType, EngineMode, type DisplayOptions, type EngineSettings, type FloorVariant, type MapView, type PlayerInit, type StormRect, type Theme, type TilePhysics } from '../types.ts';
import { applyColorVision, Palette } from '../palette.ts';
import { CAMERA, CAMERA_FX, CULL_MARGIN, MOTION_PRESETS, QUALITY_PRESETS, TILE_SIZE, type RenderOptions } from '../constants.ts';
import { EMOJI_COUNT, emojiDataUri, emojiTextureKey } from '../emoji.ts';
import { Color } from '../../theme/color.ts';
import { EFFECT_BITS, type Snapshot } from 'shared';
import {
    advanceRenderTick,
    bufferEntityPositions,
    interpolateEntityPosition,
    type EntityPositionBuffers,
} from './entityInterpolation.ts';
import { cameraFollowLerp } from './cameraSmoothing.ts';

export interface WorldSceneInit {
    theme: Theme;
    mode: EngineMode;
    settings: EngineSettings;
    onReady: (scene: WorldScene) => void;
}

/** Emoji SVGs are rasterised once at this size; the pop animation scales the sprite down from here. */
const EMOJI_TEXTURE_PX = 256;
/** Three tiles is far beyond legal movement between snapshots; corrections this large must not glide. */
const MAX_INTERPOLATION_DISTANCE_PX = 3 * TILE_SIZE;

/**
 * The actual Phaser.Scene. Never imported/constructed by consumer code — reached only through
 * `SwitchEngine`/`MapController`/`PlayerHandle`, which is the whole point of the facade split.
 */
export class WorldScene extends Phaser.Scene {
    /** 실제 경과 시간. 수명(이모지, 점멸 궤적)은 무조건 이걸 쓴다. */
    private clock = 0;
    /**
     * 장식용 애니메이션 시계 — clock과 달리 모션 설정의 animSpeed가 곱해진 dt로 흐른다.
     * 둘을 나눈 이유: "모션 줄임"에서 시계를 통째로 멈추면 진동은 멎지만 이모지와 점멸 궤적이
     * 화면에 영구히 박혀버린다. 진동만 멈추고 수명은 흐르게 하려면 시계가 두 개여야 한다.
     */
    private animClock = 0;
    private theme: Theme = 0;
    private settings: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS };
    private renderOptions: RenderOptions = {
        motion: MOTION_PRESETS[DEFAULT_ENGINE_SETTINGS.motion],
        quality: QUALITY_PRESETS[DEFAULT_ENGINE_SETTINGS.quality],
        reduceFlash: DEFAULT_ENGINE_SETTINGS.reduceFlash,
        display: { ...DEFAULT_DISPLAY_OPTIONS },
    };
    /**
     * 내부 렌더 해상도 배율. 카메라 줌에 곱해져 "게임 픽셀 / 월드 유닛"이 된다 — baseZoom은
     * CSS 픽셀 기준의 논리 줌으로 남으므로, 해상도를 바꿔도 보이는 월드 범위는 그대로다.
     */
    private renderScale = 1;
    private onReadyCb: ((scene: WorldScene) => void) | null = null;

    private mapLayer!: MapLayer;
    private blinkFx!: BlinkFxLayer;
    private switchFx!: SwitchFxLayer;
    private readonly players = new Map<number, PlayerSprite>();
    private taggerId: number | null = null;
    private selfId: number | null = null;
    private mode: EngineMode = EngineMode.Play;
    /** Play mode follows self once, after the self sprite actually exists. Explicit camera actions own it afterwards. */
    private cameraInitialized = false;
    private freeCamera = true;
    private displayOptions: DisplayOptions = { ...DEFAULT_DISPLAY_OPTIONS };
    /** Roster names that arrived before the player was visible — applied when they're first spawned. */
    private readonly pendingNicknames = new Map<number, string>();
    private entityPositionBuffers: EntityPositionBuffers = new Map();
    private latestSnapshotTick: number | null = null;
    private renderTick: number | null = null;
    private simulationHz: number | null = null;
    /** A blink event is authoritative intent to teleport; the following snapshot is snapped, never lerped. */
    private readonly pendingBlinks = new Map<number, { fromX: number; fromY: number }>();

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
    private lastUpdateErrorLogAt = Number.NEGATIVE_INFINITY;
    private suppressedUpdateErrors = 0;

    constructor() {
        super({ key: 'world' });
    }

    init(data: WorldSceneInit): void {
        this.theme = data.theme;
        this.mode = data.mode;
        this.onReadyCb = data.onReady;
        this.settings = { ...data.settings };
        this.renderScale = data.settings.resolutionScale;
        this.rebuildRenderOptions();
        applyColorVision(data.settings.colorVision);
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
        this.mapLayer.setRenderOptions(this.renderOptions);
        this.blinkFx = new BlinkFxLayer(this);
        this.switchFx = new SwitchFxLayer(this);
        this.setupCameraInput();
        this.onReadyCb?.(this);
    }

    update(_time: number, delta: number): void {
        try {
            this.updateFrame(delta);
        } catch (error) {
            this.reportUpdateError(error);
        }
    }

    private updateFrame(delta: number): void {
        const dt = Math.min(delta, 50) / 1000;
        this.clock += dt;
        this.animClock += dt * this.renderOptions.motion.animSpeed;
        this.updateInterpolatedPositions(delta);

        const view = this.cameras.main.worldView;
        const minX = view.x - CULL_MARGIN, maxX = view.right + CULL_MARGIN;
        const minY = view.y - CULL_MARGIN, maxY = view.bottom + CULL_MARGIN;

        this.mapLayer.update(this.animClock, { minX, minY, maxX, maxY });
        this.blinkFx.update(this.clock, this.animClock, this.theme, this.renderOptions);
        this.switchFx.update(this.clock, this.theme, this.renderOptions);

        for (const sprite of this.players.values()) {
            const s = sprite.state;
            const onScreen = s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY;
            sprite.update(this.clock, this.animClock, this.theme, onScreen, this.renderOptions);
        }

        this.updateCameraFx(dt, delta);
    }

    private reportUpdateError(error: unknown): void {
        const now = performance.now();
        if (now - this.lastUpdateErrorLogAt < 10_000) {
            this.suppressedUpdateErrors += 1;
            return;
        }
        console.error('[swITch] Phaser world update failed; continuing on the next frame', {
            suppressedSinceLastLog: this.suppressedUpdateErrors,
            error,
        });
        this.lastUpdateErrorLogAt = now;
        this.suppressedUpdateErrors = 0;
    }

    /**
     * Purely reactive — reads effect state the caller already pushed into the followed `PlayerSprite`
     * and turns it into camera zoom/lerp/shake. Derives nothing about the world itself (no tile lookups,
     * no concealment), same "dumb renderer" rule as everywhere else in this engine.
     */
    private updateCameraFx(dt: number, deltaMs: number): void {
        const cam = this.cameras.main;
        const followed = this.followedId !== null ? this.players.get(this.followedId) : undefined;
        const s = followed?.state;
        // 모션 강도. 0이면 아래 배율이 전부 1로 접히고 흔들림/펀치도 사라진다 — 상수마다 조건문을
        // 다는 대신 계수 하나로 모으면 "줄임 / 보통 / 풍부하게"가 한 줄로 끝난다.
        const fx = this.renderOptions.motion.cameraFx;
        const mult = (m: number) => 1 + (m - 1) * fx;
        const lerpOf = (halfLifeMs: number) => this.settings.cameraSmoothing
            ? cameraFollowLerp(deltaMs, halfLifeMs)
            : 1;

        let targetMult = 1;
        let targetLerp = lerpOf(CAMERA.followHalfLifeMs);
        if (s) {
            if (s.effects[EffectType.Dash]) {
                targetMult *= mult(CAMERA_FX.dashZoomMult);
                targetLerp = lerpOf(CAMERA_FX.dashFollowHalfLifeMs);
            }
            if (s.effects[EffectType.Exhaust]) {
                targetMult *= mult(CAMERA_FX.exhaustZoomMult);
                targetLerp = lerpOf(CAMERA_FX.exhaustFollowHalfLifeMs);
            }
            if (s.effects[EffectType.Frenzy]) {
                targetMult *= mult(CAMERA_FX.frenzyZoomMult);
                // `force=false` (default): only actually (re)starts the shake if it isn't already
                // running, so this re-arms itself just before each short shake ends — continuous tremor
                // for as long as frenzy stays active, and it decays on its own within one duration of
                // frenzy ending without us needing to track or cancel anything.
                if (this.settings.screenShake && fx > 0) {
                    cam.shake(CAMERA_FX.frenzyShakeDurationMs, CAMERA_FX.frenzyShakeIntensity * fx);
                }
            }
        }

        const zoomT = 1 - Math.exp(-CAMERA_FX.zoomLerpSpeed * dt);
        this.fxZoomMult = Phaser.Math.Linear(this.fxZoomMult, targetMult, zoomT);
        const punchT = 1 - Math.exp(-CAMERA_FX.blinkPunchDecay * dt);
        this.zoomPunch = Phaser.Math.Linear(this.zoomPunch, 0, punchT);

        // 클램프는 논리 줌(=CSS 픽셀 기준)에 걸고 렌더 해상도 배율은 그 뒤에 곱한다. 그래야
        // 해상도를 올려도 최대/최소 줌이 여전히 같은 시야를 뜻한다.
        cam.zoom = Phaser.Math.Clamp(this.baseZoom * this.fxZoomMult * (1 + this.zoomPunch), CAMERA.minZoom, CAMERA.maxZoom) * this.renderScale;
        if (!this.freeCamera) cam.setLerp(targetLerp, targetLerp);
    }

    // ---- camera ----
    // Two modes only: free (drag to pan, wheel to zoom) and follow (Phaser's own startFollow, so
    // panning/smoothing is handled by the camera itself rather than us re-centering it every frame).

    private setupCameraInput(): void {
        // 도움말 데모는 정해진 화면을 보여 주는 것이 전부다. 휠로 줌하거나 끌어서 옮길 수 있으면
        // 사용자가 화면을 잃어버리고 되돌릴 방법이 없다.
        if (this.mode === EngineMode.Help) return;
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
        this.cameraInitialized = true;
        this.followedId = id;
        this.startFollowing(sprite);
    }

    cameraFree(): void {
        this.freeCamera = true;
        this.cameraInitialized = true;
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
        this.cameraInitialized = true;
        this.followedId = null;
        this.cameras.main.stopFollow();
        this.cameras.main.centerOn(x, y);
    }

    fitMapToView(paddingPx = 0): void {
        const w = this.mapLayer.worldWidth, h = this.mapLayer.worldHeight;
        if (w <= 0 || h <= 0) return;
        this.fitRectToView(0, 0, w, h, paddingPx);
    }

    /**
     * 맵의 한 부분만 화면에 맞춘다. 도움말 데모가 맵 전체를 보여 주면 사방이 자기장 테두리로
     * 둘러싸여 실제 경기와 전혀 다르게 보인다 — 경기 중에는 늘 맵의 일부만 보인다.
     */
    fitRectToView(x: number, y: number, width: number, height: number, paddingPx = 0): void {
        if (width <= 0 || height <= 0) return;
        this.freeCamera = true;
        this.cameraInitialized = true;
        this.followedId = null;
        this.cameras.main.stopFollow();
        this.cameras.main.centerOn(x + width / 2, y + height / 2);
        // scale.width는 렌더 해상도가 곱해진 게임 픽셀이라, 논리 줌을 구하려면 되나눠야 한다.
        const zoomX = (this.scale.width / this.renderScale) / (width + paddingPx * 2);
        const zoomY = (this.scale.height / this.renderScale) / (height + paddingPx * 2);
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

    // ---- 유저 설정 ----

    /**
     * 프레임 상한과 캔버스 해상도는 Phaser.Game 레벨 값이라 SwitchEngine이 직접 처리하고, 씬은
     * 그리기에 영향을 주는 나머지만 받는다(해상도는 줌 보정 때문에 값만 알고 있으면 된다).
     */
    setSettings(settings: EngineSettings): void {
        const prevColorVision = this.settings.colorVision;
        this.settings = { ...settings };
        this.renderScale = settings.resolutionScale;
        this.rebuildRenderOptions();
        this.mapLayer.setRenderOptions(this.renderOptions);
        if (settings.colorVision !== prevColorVision && applyColorVision(settings.colorVision)) {
            // 플레이어/수풀/연막은 매 프레임 다시 그려지지만 바닥과 벽은 한 번 구워두므로 직접 무효화한다.
            this.mapLayer.refreshColors();
        }
    }

    getSettings(): EngineSettings {
        return { ...this.settings };
    }

    private rebuildRenderOptions(): void {
        this.renderOptions = {
            motion: MOTION_PRESETS[this.settings.motion],
            quality: QUALITY_PRESETS[this.settings.quality],
            reduceFlash: this.settings.reduceFlash,
            display: { ...this.displayOptions },
        };
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
        // playerId는 1부터다. 여기서 +1을 하면 로비에서 고른 자리 번호와 몸에 찍히는 숫자가 어긋나고,
        // 스위치 키(1~8)가 가리키는 사람과도 달라진다.
        s.label = init.label ?? String(id);
        s.nickname = init.nickname ?? s.nickname;
        s.isTagger = this.taggerId === id;
        s.isSelf = this.selfId === id;
        this.initializePlayCameraIfReady();
    }

    removePlayer(id: number): void {
        const sprite = this.players.get(id);
        if (!sprite) return;
        sprite.destroy();
        this.players.delete(id);
        const nextBuffers = new Map(this.entityPositionBuffers);
        nextBuffers.delete(id);
        this.entityPositionBuffers = nextBuffers;
        this.pendingBlinks.delete(id);
        if (this.taggerId === id) this.taggerId = null;
        // Keep the authoritative self id while a visibility frame temporarily omits the sprite.
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
        this.initializePlayCameraIfReady();
    }

    private initializePlayCameraIfReady(): void {
        if (this.cameraInitialized || this.mode !== EngineMode.Play || this.selfId === null) return;
        const sprite = this.players.get(this.selfId);
        if (!sprite) return;
        this.freeCamera = false;
        this.followedId = this.selfId;
        this.cameraInitialized = true;
        this.startFollowing(sprite);
    }

    private startFollowing(sprite: PlayerSprite): void {
        const initialLerp = this.settings.cameraSmoothing
            ? cameraFollowLerp(1_000 / 60, CAMERA.followHalfLifeMs)
            : 1;
        // Vector artwork needs sub-pixel camera movement. Integer snapping here turns smooth player
        // interpolation into whole-screen 1 px steps (and CSS scaling makes those steps fractional again).
        this.cameras.main.startFollow(sprite.followTarget, false, initialLerp, initialLerp);
    }

    /**
     * Applies one decoded server frame. This is the only path a real match uses — the individual setters
     * stay for the tutorial and the dev sandbox.
     *
     * The `players` list is authoritative when present: anyone absent from it is removed, because "the
     * server didn't send them" is exactly how invisibility is expressed. Sections that are absent
     * entirely mean "unchanged" and are left alone.
     */
    applySnapshot(snapshot: Snapshot, simulationHz?: number): void {
        if (simulationHz !== undefined && Number.isFinite(simulationHz) && simulationHz > 0
            && simulationHz !== this.simulationHz) {
            this.simulationHz = simulationHz;
            this.entityPositionBuffers = new Map();
            this.latestSnapshotTick = null;
            this.renderTick = null;
        }
        if (this.latestSnapshotTick !== null && snapshot.tick < this.latestSnapshotTick) {
            // A lower tick means a new authoritative timeline (for example, a new match in this scene).
            this.entityPositionBuffers = new Map();
            this.renderTick = null;
        }
        this.latestSnapshotTick = snapshot.tick;
        if (this.simulationHz !== null && this.renderTick === null) {
            this.renderTick = advanceRenderTick(null, snapshot.tick, 0, this.simulationHz);
        }

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
            const buffered = this.simulationHz === null ? null : bufferEntityPositions(
                this.entityPositionBuffers,
                snapshot.tick,
                snapshot.players,
                {
                    forceSnapIds: new Set(this.pendingBlinks.keys()),
                    maxInterpolationDistance: MAX_INTERPOLATION_DISTANCE_PX,
                },
            );
            if (buffered !== null) this.entityPositionBuffers = buffered.buffers;

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
                if (buffered === null || buffered.snappedIds.has(p.id)) {
                    s.x = p.x;
                    s.y = p.y;
                }
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
                const blink = this.pendingBlinks.get(p.id);
                if (blink !== undefined) {
                    this.pendingBlinks.delete(p.id);
                    this.playBlink(p.id, blink.fromX, blink.fromY, p.x, p.y);
                }
            }

            for (const id of [...this.players.keys()]) {
                if (!seen.has(id)) this.removePlayer(id);
            }
            for (const id of [...this.pendingBlinks.keys()]) {
                if (!seen.has(id)) this.pendingBlinks.delete(id);
            }
            this.setTagger(tagger);
        }

        // 점멸 같은 저빈도 연출은 JSON 이벤트(`player.blinked`)가 다음 위치 샘플을 snap으로 표시한다.
    }

    private updateInterpolatedPositions(deltaMs: number): void {
        if (this.simulationHz === null || this.latestSnapshotTick === null) return;
        this.renderTick = advanceRenderTick(
            this.renderTick,
            this.latestSnapshotTick,
            deltaMs,
            this.simulationHz,
        );
        for (const [id, samples] of this.entityPositionBuffers) {
            const position = interpolateEntityPosition(samples, this.renderTick);
            const state = this.players.get(id)?.state;
            if (position === null || state === undefined) continue;
            state.x = position.x;
            state.y = position.y;
        }
    }

    /**
     * 사거리 스킬 연출. **시전자가 지금 보이는 경우에만** 그린다 — 수풀에 숨은 사람의 위치가
     * 연출로 새면 안 된다. 서버는 방 전체에 보내므로 거르는 책임이 여기 있다.
     */
    playSkillArea(playerId: number, x: number, y: number, targetPlayerId: number | null, rangePx: number): void {
        const caster = this.players.get(playerId);
        if (caster === undefined || rangePx <= 0) return;
        // 지목한 상대가 있으면 그 사람 색(스위치), 없으면 시전자 색(탈진)이다.
        // 탈진은 범위 안의 모두가 걸리므로 한 사람의 색으로 칠하면 "저 사람만 걸렸다"로 읽힌다.
        // 대상이 안 보여도 번호로 색을 안다 — playerId는 1부터, colorIndex는 0부터다.
        const colorIndex = targetPlayerId === null
            ? caster.state.colorIndex
            : this.players.get(targetPlayerId)?.state.colorIndex ?? targetPlayerId - 1;
        this.switchFx.play(x, y, rangePx, colorIndex, this.clock);
    }

    markPlayerBlinked(id: number, fromX: number, fromY: number): void {
        // The event is the semantic distinction from ordinary movement. Its next visible snapshot resets
        // this player's buffer and is applied immediately, even if the travelled distance is small.
        this.pendingBlinks.set(id, { fromX, fromY });
    }

    setDisplayOptions(options: Partial<DisplayOptions>): void {
        this.displayOptions = { ...this.displayOptions, ...options };
        this.rebuildRenderOptions();
        this.mapLayer.setRenderOptions(this.renderOptions);
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
            this.zoomPunch = CAMERA_FX.blinkZoomPunch * this.renderOptions.motion.cameraFx;
            // 이 엔진에서 가장 강한 섬광이 점멸 순간의 흰 플래시라, '섬광 효과 줄이기'의 1순위 대상.
            if (!this.settings.reduceFlash && this.renderOptions.motion.cameraFx > 0) {
                this.cameras.main.flash(CAMERA_FX.blinkFlashDurationMs, 255, 255, 255);
            }
        }
    }
}
