import { useTranslation } from 'react-i18next';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { useAuthStore } from '../stores/useAuthStore.ts';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { themeColors } from '../theme/color.ts';
import { uiStatusColorsFor } from '../theme/cvd.ts';
import type { CSSProperties } from 'react';

export function AuthRecoveryPage() {
    const { t } = useTranslation();
    const retry = useAuthStore((state) => state.bootstrap);
    const theme = useSettingsStore((state) => state.theme);
    const vision = useSettingsStore((state) => state.colorVisionMode);
    const colors = themeColors(theme);
    return <main className="entry-message-screen" style={{
        '--entry-panel': colors.panel, '--entry-canvas': colors.canvas,
        '--entry-border': uiStatusColorsFor(vision, theme).warn,
        '--entry-text': colors.text, '--entry-muted': colors.muted,
    } as CSSProperties}>
        <section className="entry-message-card" role="alert" aria-live="polite">
            <span className="entry-message-kicker">swITch</span>
            <h1>{t('auth.sessionRecoveryTitle')}</h1>
            <p>{t('auth.sessionRecoveryBody')}</p>
            <RoundButton width={360} height={92} type={1} content={t('serviceStatus.retry')} onClick={() => void retry()}/>
        </section>
    </main>;
}
