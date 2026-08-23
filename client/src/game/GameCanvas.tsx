import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { SwitchEngine } from './SwitchEngine.ts';
import type { EngineMode } from './types.ts';
import { useSettingsStore } from '../stores/useSettingsStore.ts';

export interface GameCanvasProps {
    className?: string;
    style?: CSSProperties;
    /** Fires with the engine once it's mounted, and again with `null` right before it's torn down. */
    onEngine?: (engine: SwitchEngine | null) => void;
    /** Baked in at construction — changing it later remounts nothing, so pass it from the start. */
    mode?: EngineMode;
}

/**
 * Mounts a `SwitchEngine` into a full-size div and keeps it in sync with the app's theme + container
 * size. Grab the engine instance via a ref (or `onEngine`) to drive it (`ref.current?.map.load(...)`,
 * `ref.current?.spawnPlayer(...)`) — this component owns lifecycle only, not game state.
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

    useImperativeHandle<SwitchEngine | null, SwitchEngine | null>(ref, () => engine, [engine]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const nextEngine = new SwitchEngine(container, {
            theme: useSettingsStore.getState().theme,
            mode: modeRef.current,
        });
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
        // Mount/unmount only — theme changes are pushed through the effect below instead of remounting the engine.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        engine?.setTheme(theme);
    }, [engine, theme]);

    return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%', ...style }} />;
});
