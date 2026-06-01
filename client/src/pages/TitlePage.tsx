import React from "react";
import { GameContainer } from "../components/layout/GameContainer.tsx";
import swITch_Title from "../assets/images/swITch_Title.webp";
import { RoundButton } from "../components/common/RoundButton.tsx";
import { useTranslation } from "react-i18next";

export const TitlePage: React.FC = () => {
    const { t } = useTranslation();
    return (
        <GameContainer>
            <img
                src={swITch_Title}
                alt="title"
                style={{
                    position: 'absolute',
                    left: "960px",
                    top: "300px",
                    transform: "translate(-50%, -50%)",
                    width: "1070px",
                    userSelect: "none",
                }}
            />

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