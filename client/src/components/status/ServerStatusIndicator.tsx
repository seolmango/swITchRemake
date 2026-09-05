import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { probeServer } from '../../api/health.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { Color, themeColors } from '../../theme/color.ts';
import { uiStatusColorsFor } from '../../theme/cvd.ts';

type ConnectionState = 'checking' | 'online' | 'offline';

export const ServerStatusIndicator: React.FC = () => {
    const { t } = useTranslation();
    const theme = useSettingsStore((state) => state.theme);
    const colorVisionMode = useSettingsStore((state) => state.colorVisionMode);
    const [connection, setConnection] = useState<ConnectionState>('checking');
    const [latency, setLatency] = useState<number | null>(null);

    const checkConnection = useCallback(async () => {
        setConnection('checking');
        try {
            const nextLatency = await probeServer();
            setLatency(nextLatency);
            setConnection('online');
        } catch {
            setLatency(null);
            setConnection('offline');
        }
    }, []);

    useEffect(() => {
        const initialCheck = window.setTimeout(() => void checkConnection(), 0);
        const interval = window.setInterval(() => void checkConnection(), 15000);
        const handleOnline = () => void checkConnection();
        const handleOffline = () => { setLatency(null); setConnection('offline'); };

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
            window.clearTimeout(initialCheck);
            window.clearInterval(interval);
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, [checkConnection]);

    const colors = themeColors(theme);
    const statusColors = uiStatusColorsFor(colorVisionMode, theme);
    const accent = connection === 'online' ? statusColors.good : connection === 'offline' ? statusColors.bad : statusColors.checking;
    const label = connection === 'online' && latency !== null
        ? t('serverStatus.connected', { latency })
        : t(`serverStatus.${connection}`);

    return (
        <button
            type="button"
            className="server-status"
            onClick={() => void checkConnection()}
            aria-label={`${label}. ${t('serverStatus.retry')}`}
            title={t('serverStatus.retry')}
            style={{
                color: theme === 0 ? Color.black : accent,
                borderColor: theme === 0 ? colors.panelBorder : accent,
                background: theme === 0 ? Color.smoke[0] : 'transparent',
            }}
        >
            <span className={`server-status-dot is-${connection}`} style={{ '--status-accent': accent } as React.CSSProperties}/>
            <span aria-live="polite">{label}</span>
        </button>
    );
};
