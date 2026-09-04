import Phaser from 'phaser';
import { WorldScene, type WorldSceneInit } from './internal/WorldScene.ts';
import type { SceneAccessor } from './internal/SceneAccessor.ts';
import { MapController } from './MapController.ts';
import { PlayerHandle } from './PlayerHandle.ts';
import { DEFAULT_DISPLAY_OPTIONS, DEFAULT_ENGINE_SETTINGS, EngineMode, type DisplayOptions, type EngineSettings, type PlayerInit, type Theme } from './types.ts';
import { decodeSnapshot, type Snapshot, type TrainingPad } from 'shared';
import { phaserFpsLimit } from './internal/frameRateLimit.ts';

export interface SwitchEngineOptions {
    theme?: Theme;
    /** Defaults to `play`. Gates input/camera defaults, not rendering — see BASE.md §12.2. */
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
        /** 맵의 한 부분만 화면에 맞춘다. 도움말 데모가 쓴다. */
        fitRect: (x: number, y: number, width: number, height: number, paddingPx?: number) => void;
    };

    private readonly game: Phaser.Game;
    private readonly _accessor: SceneAccessor;
    private scene: WorldScene | null = null;
    private pendingOps: Array<() => void> = [];
    private pendingSnapshot: { snapshot: Snapshot; simulationHz?: number } | null = null;
    private readonly playerHandles = new Map<number, PlayerHandle>();
    private settings: EngineSettings;
    private readonly readyPromise: Promise<void>;
    private resolveReady!: () => void;
    /** 마지막으로 요청받은 CSS 픽셀 크기. 해상도 배율만 바뀌었을 때 다시 계산하려면 필요하다. */
    private cssWidth: number;
    private cssHeight: number;

    constructor(container: HTMLElement, options: SwitchEngineOptions = {}) {
        this.readyPromise = new Promise<void>((resolve) => { this.resolveReady = resolve; });
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
            fitRect: (x, y, width, height, paddingPx = 0) =>
                accessor.withScene((s) => s.fitRectToView(x, y, width, height, paddingPx)),
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
            // Phaser의 PreFX/PostFX는 이 게임이 한 줄도 쓰지 않는데, 켜져 있으면 부팅할 때
            // `PipelineManager.boot()`이 32px 간격으로 정사각 RenderTarget 사다리를 통째로 미리 만든다
            // (32² 부터 캔버스 짧은 변까지, 크기마다 3개 + 전체 화면 3개).
            // 1920x1080 캔버스에서 약 180MB다. 창을 세 개 띄우면 그것만으로 500MB가 넘고,
            // 엔진을 다시 만들 때마다 또 잡는다. 사용자가 겪은 out-of-memory의 가장 큰 몫이 여기였다.
            // 나중에 FX를 실제로 쓸 일이 생기면 그때 필요한 쪽만 켠다.
            disablePreFX: true,
            disablePostFX: true,
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
            fps: { target: 60, limit: phaserFpsLimit(this.settings.frameRate) },
        });

        const init: WorldSceneInit = {
            theme: options.theme ?? 0,
            mode: this.mode,
            settings: this.settings,
            onReady: (scene) => {
                this.scene = scene;
                const ops = this.pendingOps;
                this.pendingOps = [];
                for (const op of ops) op();
                const pendingSnapshot = this.pendingSnapshot;
                this.pendingSnapshot = null;
                if (pendingSnapshot) scene.applySnapshot(pendingSnapshot.snapshot, pendingSnapshot.simulationHz);
                this.resolveReady();
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

    /** Resolves after Phaser created the world scene and all boot-time operations were applied. */
    whenReady(): Promise<void> {
        return this.readyPromise;
    }

    /** Low-frequency HUD sampling only; callers should not poll this into React every frame. */
    getActualFps(): number {
        return this.game.loop.actualFps;
    }

    private applyFrameRate(frameRate: number): void {
        const loop = this.game.loop as unknown as TimeStepInternals;
        const limit = phaserFpsLimit(frameRate);
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
    applySnapshot(buffer: ArrayBuffer, simulationHz?: number): Snapshot {
        const snapshot = decodeSnapshot(buffer);
        if (this.scene) this.scene.applySnapshot(snapshot, simulationHz);
        else this.pendingSnapshot = simulationHz === undefined ? { snapshot } : { snapshot, simulationHz };
        return snapshot;
    }

    /** Marks the next authoritative position for this player as an intentional teleport. */
    applyPlayerBlinked(playerId: number, fromX: number, fromY: number): void {
        this._accessor.withScene((s) => s.markPlayerBlinked(playerId, fromX, fromY));
    }

    /**
     * 사거리 스킬(스위치·탈진) 연출. `rangePx`는 서버가 `game.starting`으로 알려 준 값을 그대로
     * 넘긴다 — 클라이언트가 사거리를 따로 알고 있으면 밸런스를 고칠 때 조용히 어긋난다.
     *
     * `targetPlayerId`는 스위치에만 있다. 없으면 시전자 색으로 그린다.
     */
    playSkillArea(playerId: number, x: number, y: number, targetPlayerId: number | null, rangePx: number): void {
        this._accessor.withScene((s) => s.playSkillArea(playerId, x, y, targetPlayerId, rangePx));
    }

    /** 서버가 보낸 훈련장 판정 반경을 그대로 바닥 레이어에 반영한다. */
    setTrainingPads(pads: readonly TrainingPad[]): void {
        this._accessor.withScene((s) => s.setTrainingPads(pads));
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
        // 두 번째 인자(noReturn)는 반드시 false여야 한다. true면 Phaser가 `PluginCache`의
        // **코어 플러그인을 전역에서** 지워 버려서, 그 뒤로 이 페이지에서 만드는 모든 Phaser.Game이
        // 부팅 중에 죽는다(`Cannot read properties of undefined (reading 'emit')`).
        // 이 엔진은 로비→인게임→결과를 오갈 때마다 새로 만들어지므로 두 번째 경기부터 화면이 안 뜬다.
        // 메모리를 아끼려고 켰다가 그렇게 됐다. Phaser 문서에도 "같은 페이지에서 다시 만들 수 없다"고
        // 적혀 있다.
        //
        // 남은 의심: 파괴한 뒤에도 WebGL 컨텍스트가 브라우저에 계속 잡혀 있는 것으로 보인다.
        // `WEBGL_lose_context`로 명시적으로 끊는 것을 시도했지만, 끊는 시점을 Phaser의 지연된
        // `runDestroy()`와 맞추는 데 실패했다(먼저 끊으면 캔버스가 DOM에 남고, 직접 `runDestroy()`를
        // 부르면 StrictMode의 즉시 언마운트에서 SceneManager가 터진다). 확인되지 않은 채로 넣지 않는다.
        this.game.destroy(true);
        this.scene = null;
        this.pendingOps = [];
        this.pendingSnapshot = null;
        this.resolveReady();
        this.playerHandles.clear();
    }
}
