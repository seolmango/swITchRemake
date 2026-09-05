import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { Color, themeColors } from '../theme/color.ts';
import { applyAppearanceToDocument } from '../theme/cssVariables.ts';

export const UnsupportedBrowserPage: React.FC = () => {
    const { t, i18n } = useTranslation();
    const language = useSettingsStore((state) => state.language);
    const theme = useSettingsStore((state) => state.theme);
    const motionLevel = useSettingsStore((state) => state.motionLevel);
    const colorVisionMode = useSettingsStore((state) => state.colorVisionMode);
    const colors = themeColors(theme);

    useEffect(() => {
        if (i18n.language !== language) void i18n.changeLanguage(language);
        document.documentElement.lang = language;
        applyAppearanceToDocument(theme, motionLevel, colorVisionMode);
        document.title = `${t('browserUnsupported.title')} · swITch`;
    }, [colorVisionMode, i18n, language, motionLevel, t, theme]);

    return (
        <main
            className="entry-message-screen"
            style={{
                '--entry-panel': colors.panel,
                '--entry-canvas': colors.canvas,
                '--entry-border': theme === 0 ? Color.red[1] : Color.red[2],
                '--entry-text': colors.text,
                '--entry-muted': colors.muted,
                '--entry-field': colors.field,
            } as React.CSSProperties}
        >
            <section className="entry-message-card" role="alert">
                <span className="entry-message-kicker">swITch</span>
                <h1>{t('browserUnsupported.title')}</h1>
                <p>{t('browserUnsupported.body')}</p>
                <div className="browser-support-list" aria-label={t('browserUnsupported.supported')}>
                    <strong>{t('browserUnsupported.supported')}</strong>
                    <span>{t('browserUnsupported.desktop')}</span>
                    <span>{t('browserUnsupported.mobile')}</span>
                </div>
            </section>
        </main>
    );
};
