import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { probeServer } from '../../api/health.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { themeColors } from '../../theme/color.ts';
import { uiStatusColorsFor } from '../../theme/cvd.ts';

type ConnectionState = 'checking' | 'online' | 'offline';

/** 타이틀 화면이 서버를 다시 확인하는 간격. 누를 필요 없이 저절로 갱신된다. */
const PROBE_INTERVAL_MS = 10_000;

/**
 * 매칭 서버 연결 상태(BASE.md §12.4): 점 + "32ms · 패치 0.5.0".
 *
 * 누르는 버튼이 아니라 읽는 글자다. 탭이 가려져 있는 동안은 묻지 않고, 다시 보이면 바로 한 번 묻는다.
 * 두 번째 확인부터는 결과가 올 때까지 이전 값을 그대로 둔다 — 10초마다 "연결 중"으로 깜빡이면 거슬린다.
 */
export const ServerStatusIndicator: React.FC = () => {
    const { t } = useTranslation();
    const theme = useSettingsStore((state) => state.theme);
    const colorVisionMode = useSettingsStore((state) => state.colorVisionMode);
    const [connection, setConnection] = useState<ConnectionState>('checking');
    const [latency, setLatency] = useState<number | null>(null);
    const [versions, setVersions] = useState<string[]>([]);

    useEffect(() => {
        let cancelled = false;
        let inFlight = false;
        const check = async () => {
            if (inFlight || document.visibilityState === 'hidden') return;
            inFlight = true;
            try {
                const probe = await probeServer();
                if (cancelled) return;
                setLatency(probe.latencyMs);
                setVersions(probe.rulesVersions);
                setConnection('online');
            } catch {
                if (cancelled) return;
                setLatency(null);
                setConnection('offline');
            } finally {
                inFlight = false;
            }
        };
        const handleVisibility = () => { if (document.visibilityState === 'visible') void check(); };
        const handleOffline = () => { setLatency(null); setConnection('offline'); };

        void check();
        const interval = window.setInterval(() => void check(), PROBE_INTERVAL_MS);
        document.addEventListener('visibilitychange', handleVisibility);
        window.addEventListener('online', handleVisibility);
        window.addEventListener('offline', handleOffline);
        return () => {
            cancelled = true;
            window.clearInterval(interval);
            document.removeEventListener('visibilitychange', handleVisibility);
            window.removeEventListener('online', handleVisibility);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    const statusColors = uiStatusColorsFor(colorVisionMode, theme);
    const accent = connection === 'online' ? statusColors.good : connection === 'offline' ? statusColors.bad : statusColors.checking;
    const parts = [
        connection === 'online' && latency !== null ? t('serverStatus.latency', { latency }) : t(`serverStatus.${connection}`),
        ...(connection === 'online' && versions.length > 0 ? [t('serverStatus.patch', { version: versions.join(' / ') })] : []),
    ];

    return (
        <p className="server-status" role="status" style={{ color: themeColors(theme).text }}>
            <span className={`server-status-dot is-${connection}`} style={{ '--status-accent': accent } as React.CSSProperties}/>
            <span>{parts.join(' · ')}</span>
        </p>
    );
};
