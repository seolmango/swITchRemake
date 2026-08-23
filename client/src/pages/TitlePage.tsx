import React, { useEffect } from "react";
import { RoundButton } from "../components/common/RoundButton.tsx";
import { useTranslation } from "react-i18next";
import { TitleLogo } from "../components/common/logo.tsx";
import { useNavigate } from "react-router-dom";
import { SettingsDock } from "../components/layout/SettingsDock.tsx";
import { ServerStatusIndicator } from '../components/status/ServerStatusIndicator.tsx';

export const TitlePage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    useEffect(() => { document.title = 'swITch'; }, []);
    return (
        <main className="page-screen">
            <h1 className="visually-hidden">swITch</h1>
            <TitleLogo x={960} y={300} width={1080}/>

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
