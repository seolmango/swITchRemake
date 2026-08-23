import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { SwitchEngine } from './SwitchEngine.ts';
import type { EngineMode } from './types.ts';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { useEngineSettings } from './useEngineSettings.ts';

export interface GameCanvasProps {
    className?: string;
    style?: CSSProperties;
    /** Fires with the engine once it's mounted, and again with `null` right before it's torn down. */
    onEngine?: (engine: SwitchEngine | null) => void;
    /** Baked in at construction — changing it later remounts nothing, so pass it from the start. */
    mode?: EngineMode;
}

/**
 * Mounts a `SwitchEngine` into a full-size div and keeps it in sync with the app's theme, user settings
 * and container size. Grab the engine instance via a ref (or `onEngine`) to drive it
 * (`ref.current?.map.load(...)`, `ref.current?.spawnPlayer(...)`) — this component owns lifecycle only,
 * not game state.
 *
 * 설정 반영이 여기 있는 이유: 엔진을 마운트하는 지점이 하나뿐이라, 여기서 밀어넣으면 인게임이든
 * 튜토리얼이든 개발 샌드박스든 페이지가 따로 배선하지 않아도 설정이 전부 적용된다.
 */
export const GameCanvas = forwardRef<SwitchEngine | null, GameCanvasProps>(function GameCanvas(
    { className, style, onEngine, mode },
    ref,
) {
    const modeRef = useRef(mode);
    modeRef.current = mode;
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [engine, setEngine] = useState<SwitchEngine | null>(null);
    const theme = useSettingsStore((state) => state.theme);
    const { settings, display } = useEngineSettings();
    // 생성 시점에 최신 설정을 넘기기 위한 참조. 마운트 이펙트는 의도적으로 한 번만 돌기 때문에
    // 여기서 state를 직접 읽으면 첫 렌더 시점의 값에 고정된다.
    const bootRef = useRef({ settings, display });
    bootRef.current = { settings, display };

    useImperativeHandle<SwitchEngine | null, SwitchEngine | null>(ref, () => engine, [engine]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const nextEngine = new SwitchEngine(container, {
            theme: useSettingsStore.getState().theme,
            mode: modeRef.current,
            settings: bootRef.current.settings,
        });
        nextEngine.setDisplayOptions(bootRef.current.display);
        setEngine(nextEngine);
        onEngine?.(nextEngine);

        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) return;
            const { width, height } = entry.contentRect;
            if (width > 0 && height > 0) nextEngine.resize(width, height);
        });
        observer.observe(container);

        return () => {
            observer.disconnect();
            nextEngine.destroy();
            setEngine(null);
            onEngine?.(null);
        };
        // Mount/unmount only — theme and settings changes are pushed through the effects below instead
        // of remounting the engine.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        engine?.setTheme(theme);
    }, [engine, theme]);

    useEffect(() => {
        engine?.setSettings(settings);
    }, [engine, settings]);

    useEffect(() => {
        engine?.setDisplayOptions(display);
    }, [engine, display]);

    return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%', ...style }} />;
});
