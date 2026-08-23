import Phaser from 'phaser';
import { WorldScene, type WorldSceneInit } from './internal/WorldScene.ts';
import type { SceneAccessor } from './internal/SceneAccessor.ts';
import { MapController } from './MapController.ts';
import { PlayerHandle } from './PlayerHandle.ts';
import { DEFAULT_DISPLAY_OPTIONS, DEFAULT_ENGINE_SETTINGS, EngineMode, type DisplayOptions, type EngineSettings, type PlayerInit, type Theme } from './types.ts';
import { decodeSnapshot } from 'shared';

export interface SwitchEngineOptions {
    theme?: Theme;
    /** Defaults to `play`. Gates input/camera defaults, not rendering — see docs/ENGINE.md. */
    mode?: EngineMode;
    /** 유저 설정. 생성 시점부터 적용된다(첫 프레임이 기본값으로 그려졌다가 바뀌는 깜빡임 방지). */
    settings?: Partial<EngineSettings>;
}

/**
 * Phaser의 TimeStep은 fps 상한을 생성 시 config로만 받고 런타임 setter가 없다. 내부 필드를 직접
 * 갈아끼운 뒤 sleep/wake로 루프 콜백을 다시 묶어주면 재생성 없이 바뀐다 — `wake()`가
 * `hasFpsLimit`을 보고 step 함수를 새로 바인딩하기 때문에 이 두 줄이 반드시 필요하다.
 */
interface TimeStepInternals {
    fpsLimit: number;
    hasFpsLimit: boolean;
    _limitRate: number;
    sleep: () => void;
    wake: (seamless?: boolean) => void;
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
    private settings: EngineSettings;
    /** 마지막으로 요청받은 CSS 픽셀 크기. 해상도 배율만 바뀌었을 때 다시 계산하려면 필요하다. */
    private cssWidth: number;
    private cssHeight: number;

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

        this.settings = { ...DEFAULT_ENGINE_SETTINGS, ...options.settings };
        const width = Math.max(1, container.clientWidth);
        const height = Math.max(1, container.clientHeight);
        this.cssWidth = width;
        this.cssHeight = height;
        const scaled = this.backingSize(width, height);

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
                // RESIZE가 아니라 NONE인 이유: RESIZE 모드의 updateScale()은 캔버스 백버퍼 크기를
                // 매번 부모 엘리먼트 크기로 덮어써서, "CSS 크기와 다른 내부 해상도"를 만들 수가 없다.
                // 컨테이너 리사이즈는 어차피 GameCanvas의 ResizeObserver가 잡아 resize()를 부르므로
                // 크기를 우리가 직접 몰아주는 편이 렌더 해상도 설정과도 맞아떨어진다.
                mode: Phaser.Scale.NONE,
                parent: container,
                width: scaled.width,
                height: scaled.height,
                zoom: scaled.zoom,
            },
            fps: { target: 60, limit: this.settings.frameRate },
        });

        const init: WorldSceneInit = {
            theme: options.theme ?? 0,
            settings: this.settings,
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
     * 유저 설정을 반영한다. 전부 순수 로컬 값이라 서버로 나가지 않고, 서버가 보내주는 정보의 양도
     * 바꾸지 않는다 — 같은 정보를 어떻게 그릴지만 정한다. 부분 갱신이라 바뀐 항목만 넘겨도 된다.
     */
    setSettings(patch: Partial<EngineSettings>): void {
        const prev = this.settings;
        const next = { ...prev, ...patch };
        this.settings = next;

        if (next.frameRate !== prev.frameRate) this.applyFrameRate(next.frameRate);
        if (next.resolutionScale !== prev.resolutionScale) this.resize(this.cssWidth, this.cssHeight);
        this._accessor.withScene((s) => s.setSettings(next));
    }

    getSettings(): EngineSettings {
        return { ...this.settings };
    }

    private applyFrameRate(frameRate: number): void {
        const loop = this.game.loop as unknown as TimeStepInternals;
        const limit = frameRate > 0 ? frameRate : 0;
        if (loop.fpsLimit === limit) return;
        loop.fpsLimit = limit;
        loop.hasFpsLimit = limit > 0;
        loop._limitRate = limit > 0 ? 1000 / limit : 0;
        // sleep→wake로 루프 콜백을 다시 바인딩한다. 상한을 켜고 끄는 건 이 재바인딩 없이는 안 먹는다.
        loop.sleep();
        loop.wake(true);
    }

    /**
     * CSS 픽셀 크기 → 캔버스 백버퍼 크기 + 그걸 다시 CSS 크기로 되돌리는 zoom.
     * Phaser는 canvas.width를 `width`로, CSS 표시 크기를 `width * zoom`으로 잡으므로,
     * zoom을 배율의 역수로 두면 화면에서 차지하는 크기는 그대로 두고 픽셀 밀도만 바뀐다.
     */
    private backingSize(cssWidth: number, cssHeight: number): { width: number; height: number; zoom: number } {
        const scale = this.settings.resolutionScale;
        const width = Math.max(1, Math.round(cssWidth * scale));
        const height = Math.max(1, Math.round(cssHeight * scale));
        // 반올림 오차까지 흡수하도록 실제 백버퍼 크기에서 zoom을 역산한다.
        return { width, height, zoom: cssWidth / width };
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

    /** `width`/`height`는 CSS 픽셀. 내부 해상도는 `resolutionScale`에 따라 여기서 따로 계산된다. */
    resize(width: number, height: number): void {
        this.cssWidth = Math.max(1, width);
        this.cssHeight = Math.max(1, height);
        const scaled = this.backingSize(this.cssWidth, this.cssHeight);
        this.game.scale.zoom = scaled.zoom;
        this.game.scale.resize(scaled.width, scaled.height);
        // 표시 크기는 Phaser에 맡기지 않고 직접 못박는다. ScaleManager.resize는 계산된 스타일 크기가
        // 백버퍼 크기와 같을 때(= 배율 100%) style을 아예 건드리지 않아서, 125%에서 100%로 되돌리면
        // 이전 배율이 남긴 px 값이 그대로 붙어 있게 된다.
        const canvas = this.game.canvas;
        if (canvas) {
            canvas.style.width = `${this.cssWidth}px`;
            canvas.style.height = `${this.cssHeight}px`;
        }
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
