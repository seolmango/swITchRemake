import { useEffect, useState } from 'react';
import type { SwitchEngine } from '../SwitchEngine.ts';
import type { Theme } from '../types.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { HUD_FONT, mutedText, panel } from './hudTheme.ts';

interface Props {
    theme: Theme;
    engine: SwitchEngine | null;
    latencyMs: number | null;
    estimatedTps: number | null;
}

export function PerformanceStats({ theme, engine, latencyMs, estimatedTps }: Props) {
    const showLatency = useSettingsStore((state) => state.showLatency);
    const showFps = useSettingsStore((state) => state.showFps);
    const showTps = useSettingsStore((state) => state.showTps);
    const [fps, setFps] = useState<number | null>(null);

    useEffect(() => {
        if (!engine || !showFps) {
            return;
        }
        const sample = () => {
            const next = Math.max(0, Math.round(engine.getActualFps()));
            setFps((current) => current === next ? current : next);
        };
        const initialTimer = window.setTimeout(sample, 0);
        const timer = window.setInterval(sample, 500);
        return () => {
            window.clearTimeout(initialTimer);
            window.clearInterval(timer);
        };
    }, [engine, showFps]);

    if (!showLatency && !showFps && !showTps) return null;

    return (
        <div
            aria-label="Network and rendering diagnostics"
            style={{
                ...panel(theme),
                position: 'absolute',
                right: 16,
                bottom: 16,
                zIndex: 4,
                display: 'flex',
                gap: 12,
                padding: '7px 11px',
                color: mutedText(theme),
                fontFamily: HUD_FONT,
                fontSize: 12,
                fontWeight: 800,
                fontVariantNumeric: 'tabular-nums',
                pointerEvents: 'none',
            }}
        >
            {showLatency && <span title="Round-trip time">RTT {latencyMs === null ? '--' : `${latencyMs} ms`}</span>}
            {showFps && <span>FPS {fps ?? '--'}</span>}
            {showTps && <span title="Estimated from snapshot tick arrivals">TPS≈ {estimatedTps?.toFixed(1) ?? '--'}</span>}
        </div>
    );
}
