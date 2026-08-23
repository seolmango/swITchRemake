import Phaser from 'phaser';
import { WorldScene, type WorldSceneInit } from './internal/WorldScene.ts';
import type { SceneAccessor } from './internal/SceneAccessor.ts';
import { MapController } from './MapController.ts';
import { PlayerHandle } from './PlayerHandle.ts';
import { DEFAULT_DISPLAY_OPTIONS, EngineMode, type DisplayOptions, type PlayerInit, type Theme } from './types.ts';
import { decodeSnapshot } from './protocol/decode.ts';

export interface SwitchEngineOptions {
    theme?: Theme;
    /** Defaults to `play`. Gates input/camera defaults, not rendering — see docs/ENGINE.md. */
    mode?: EngineMode;
}

/**
 * The public entry point to the renderer. Owns a Phaser.Game and never exposes it — every mutation
 * happens through this class (or `.map` / `.player(id)`), so callers never touch a raw Phaser object.
 * Safe to call immediately after construction: operations queue until the scene finishes booting.
 */
export class SwitchEngine {
    readonly mode: EngineMode;
    readonly map: MapController;
    readonly camera: {
        follow: (id: number) => void;
        free: () => void;
        setZoom: (zoom: number) => void;
        getZoom: () => number;
        isFree: () => boolean;
        centerOn: (x: number, y: number) => void;
        fitMap: (paddingPx?: number) => void;
    };

    private readonly game: Phaser.Game;
    private readonly _accessor: SceneAccessor;
    private scene: WorldScene | null = null;
    private pendingOps: Array<() => void> = [];
    private readonly playerHandles = new Map<number, PlayerHandle>();

    constructor(container: HTMLElement, options: SwitchEngineOptions = {}) {
        const accessor: SceneAccessor = {
            withScene: (fn) => {
                if (this.scene) fn(this.scene);
                else this.pendingOps.push(() => fn(this.scene!));
            },
            readScene: (fn, fallback) => (this.scene ? fn(this.scene) : fallback),
        };

        this._accessor = accessor;
        this.mode = options.mode ?? EngineMode.Play;
        this.map = new MapController(accessor);
        this.camera = {
            follow: (id) => accessor.withScene((s) => s.cameraFollow(id)),
            free: () => accessor.withScene((s) => s.cameraFree()),
            setZoom: (zoom) => accessor.withScene((s) => s.setCameraZoom(zoom)),
            getZoom: () => accessor.readScene((s) => s.getCameraZoom(), 1),
            isFree: () => accessor.readScene((s) => s.isCameraFree(), true),
            centerOn: (x, y) => accessor.withScene((s) => s.cameraCenterOn(x, y)),
            fitMap: (paddingPx = 0) => accessor.withScene((s) => s.fitMapToView(paddingPx)),
        };

        const width = Math.max(1, container.clientWidth);
        const height = Math.max(1, container.clientHeight);

        this.game = new Phaser.Game({
            type: Phaser.AUTO,
            parent: container,
            transparent: false,
            banner: false,
            // Lets canvas.toDataURL()/readPixels capture the actual last-rendered frame (default false
            // lets the browser clear the WebGL buffer right after compositing) — needed for any tooling
            // that screenshots the canvas directly instead of via the OS compositor.
            render: { preserveDrawingBuffer: true },
            scale: {
                mode: Phaser.Scale.RESIZE,
                parent: container,
                width,
                height,
            },
            fps: { target: 60 },
        });

        const init: WorldSceneInit = {
            theme: options.theme ?? 0,
            onReady: (scene) => {
                this.scene = scene;
                const ops = this.pendingOps;
                this.pendingOps = [];
                for (const op of ops) op();
            },
        };
        this.game.scene.add('world', WorldScene, true, init);
    }

    setTheme(theme: Theme): void {
        this._accessor.withScene((s) => s.setTheme(theme));
    }

    /**
     * Feeds one server frame straight in — the engine decodes the binary itself so callers never have to
     * translate the wire format into engine calls. This is the only state input a real match needs.
     */
    applySnapshot(buffer: ArrayBuffer): void {
        const snapshot = decodeSnapshot(buffer);
        this._accessor.withScene((s) => s.applySnapshot(snapshot));
    }

    /** Local view preferences (in-body number, nickname above head). Never leaves the client. */
    setDisplayOptions(options: Partial<DisplayOptions>): void {
        this._accessor.withScene((s) => s.setDisplayOptions(options));
    }

    getDisplayOptions(): DisplayOptions {
        return this._accessor.readScene((s) => s.getDisplayOptions(), { ...DEFAULT_DISPLAY_OPTIONS });
    }

    resize(width: number, height: number): void {
        this.game.scale.resize(width, height);
    }

    player(id: number): PlayerHandle {
        let handle = this.playerHandles.get(id);
        if (!handle) {
            handle = new PlayerHandle(this._accessor, id);
            this.playerHandles.set(id, handle);
        }
        return handle;
    }

    spawnPlayer(id: number, init: PlayerInit): PlayerHandle {
        this._accessor.withScene((s) => s.spawnPlayer(id, init));
        return this.player(id);
    }

    removePlayer(id: number): void {
        this._accessor.withScene((s) => s.removePlayer(id));
        this.playerHandles.delete(id);
    }

    setTagger(id: number | null): void {
        this._accessor.withScene((s) => s.setTagger(id));
    }

    setSelf(id: number | null): void {
        this._accessor.withScene((s) => s.setSelf(id));
    }

    destroy(): void {
        this.game.destroy(true);
        this.scene = null;
        this.pendingOps = [];
        this.playerHandles.clear();
    }
}
