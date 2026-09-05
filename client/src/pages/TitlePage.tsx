import React, { useEffect } from "react";
import { RoundButton } from "../components/common/RoundButton.tsx";
import { useTranslation } from "react-i18next";
import { TitleLogo } from "../components/common/logo.tsx";
import { useNavigate } from "react-router-dom";
import { SettingsDock } from "../components/layout/SettingsDock.tsx";
import { ServerStatusIndicator } from '../components/status/ServerStatusIndicator.tsx';
import { localizedServiceText, type ServiceAnnouncement } from '../api/health.ts';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { Color, themeColors } from '../theme/color.ts';

export const TitlePage: React.FC<{ announcement?: ServiceAnnouncement | null }> = ({ announcement = null }) => {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const theme = useSettingsStore((state) => state.theme);
    const colors = themeColors(theme);
    useEffect(() => { document.title = 'swITch'; }, []);
    return (
        <main className="page-screen">
            <h1 className="visually-hidden">swITch</h1>
            <TitleLogo x={960} y={300} width={1080}/>

            {announcement && (
                <section
                    className="title-announcement"
                    role="status"
                    aria-label={t('titlePage.announcement')}
                    style={{
                        '--title-notice-fill': theme === 0 ? Color.blue[0] : 'transparent',
                        '--title-notice-border': theme === 0 ? Color.blue[1] : Color.blue[2],
                        '--title-notice-text': colors.text,
                    } as React.CSSProperties}
                >
                    <strong>{t('titlePage.announcement')}</strong>
                    <span>{localizedServiceText(announcement.message, i18n.language)}</span>
                </section>
            )}

            <RoundButton
                x={960}
                y={650}
                width={600}
                height={120}
                type={0}
                content={t('titlePage.button.gameStart')}
                onClick={() => navigate('/rooms')}
            />

            <RoundButton
                x={960}
                y={810}
                width={600}
                height={120}
                type={1}
                content={t('titlePage.button.gameGuide')}
                onClick={() => navigate('/how-to-play')}
            />

            <SettingsDock showProfile/>
            <ServerStatusIndicator/>
        </main>
    )
}
