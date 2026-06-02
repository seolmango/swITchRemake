import React from "react";
import { GameContainer } from "../components/layout/GameContainer.tsx";
import { RoundButton } from "../components/common/RoundButton.tsx";
import { useTranslation } from "react-i18next";
import { TitleLogo } from "../components/common/logo.tsx";

export const TitlePage: React.FC = () => {
    const { t } = useTranslation();
    return (
        <GameContainer>
            <TitleLogo x={960} y={300} width={1080}/>

            <RoundButton
                x={960}
                y={700}
                width={400}
                height={100}
                type={0}
                content={t('button.game-start')}
                onClick={() => {}}
            />
        </GameContainer>
    )
}