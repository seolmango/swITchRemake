import React from "react";
import { GameContainer } from "../components/layout/GameContainer.tsx";
import swITch_Title from "../assets/images/swITch_Title.webp";
import { RoundButton } from "../components/common/RoundButton.tsx";

export const TitlePage: React.FC = () => {
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
                theme={0}
                type={0}
                content="Start Game"
                size={36}
                onClick={() => {}}
            />
        </GameContainer>
    )
}