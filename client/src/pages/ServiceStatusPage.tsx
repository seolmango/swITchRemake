import React from 'react';
import { useTranslation } from 'react-i18next';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { Color, themeColors } from '../theme/color.ts';
import { localizedServiceText, type ServiceStatus } from '../api/health.ts';
import { GameContainer } from '../components/layout/GameContainer.tsx';

export const ServiceStatusPage: React.FC<{
    status: Extract<ServiceStatus, { kind: 'maintenance' | 'offline' }> | { kind: 'checking' };
    checking: boolean;
    onRetry: () => void;
}> = ({ status, checking, onRetry }) => {
    const { t, i18n } = useTranslation();
    const theme = useSettingsStore((state) => state.theme);
    const colors = themeColors(theme);
    const maintenance = status.kind === 'maintenance';
    const title = t(status.kind === 'checking' ? 'serviceStatus.checkingTitle' : maintenance ? 'serviceStatus.maintenanceTitle' : 'serviceStatus.offlineTitle');
    const body = status.kind === 'checking'
        ? t('serviceStatus.checkingBody')
        : maintenance
            ? status.notice ? localizedServiceText(status.notice, i18n.language) : t('serviceStatus.maintenanceBody')
            : t('serviceStatus.offlineBody');

    React.useEffect(() => {
        document.title = `${title} · swITch`;
    }, [title]);

    return (
        <GameContainer>
            <main
                className="entry-message-screen"
                style={{
                    '--entry-panel': colors.panel,
                    '--entry-canvas': colors.canvas,
                    '--entry-border': maintenance ? Color.frenzy[2] : theme === 0 ? Color.red[1] : Color.red[2],
                    '--entry-text': colors.text,
                    '--entry-muted': colors.muted,
                    '--entry-field': colors.field,
                } as React.CSSProperties}
            >
                <section className="entry-message-card" role={status.kind === 'checking' ? 'status' : 'alert'} aria-live="polite">
                    <span className="entry-message-kicker">swITch</span>
                    <h1>{title}</h1>
                    <p>{body}</p>
                    {maintenance && (
                        <div className="service-return-time">
                            <span>{t('serviceStatus.returnsAt')}</span>
                            <strong>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(status.returnsAt))}</strong>
                        </div>
                    )}
                    {status.kind === 'offline' && (
                        <RoundButton width={360} height={92} type={1} content={t('serviceStatus.retry')} isLoading={checking} onClick={onRetry}/>
                    )}
                </section>
            </main>
        </GameContainer>
    );
};
