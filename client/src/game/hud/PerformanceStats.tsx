import { useEffect, useState } from 'react';
import type { SwitchEngine } from '../SwitchEngine.ts';
import type { Theme } from '../types.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { HUD_FONT, HUD_METRICS, mutedText, panel } from './hudTheme.ts';

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
                left: '50%',
                bottom: HUD_METRICS.corner,
                transform: 'translateX(-50%)',
                zIndex: 4,
                display: 'flex',
                gap: 16,
                padding: '9px 14px',
                color: mutedText(theme),
                fontFamily: HUD_FONT,
                fontSize: HUD_METRICS.captionFont,
                fontWeight: 800,
                fontVariantNumeric: 'tabular-nums',
                pointerEvents: 'none',
            }}
        >
            {showLatency && <span title="Round-trip time">RTT {latencyMs === null ? '--' : `${latencyMs} ms`}</span>}
            {showFps && <span>FPS {fps ?? '--'}</span>}
            {/* 시뮬레이션 tick/초다. 스냅샷은 초당 30번 오지만 그 안의 tick 번호가 2씩 오르므로
                정상값은 60이다. 라벨만 보면 "스냅샷 초당 횟수"로 읽혀서 실제로 오해가 있었다. */}
            {showTps && <span title="Server simulation ticks per second (60). Snapshots arrive at 30/s, two ticks apart.">TPS≈ {estimatedTps?.toFixed(1) ?? '--'}</span>}
        </div>
    );
}
