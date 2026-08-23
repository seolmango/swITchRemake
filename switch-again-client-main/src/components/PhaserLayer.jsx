import React, { useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import Phaser from "phaser";
import { GameScene } from "./Game/Engine";

import tilesImage from "../assets/tm.jpg";

export const PhaserLayer = forwardRef(({ x, y, width, height, settingsRef, onGameReady, onSkillUse }, ref) => {
    const gameContainer = useRef(null);
    const sceneInstance = useRef(null);

    useImperativeHandle(ref, () => ({
        setMap: (mapData, tileSize) => {
            sceneInstance.current?.setMap(mapData, tileSize);
        },
        updateMapTiles: (updates) => {
            sceneInstance.current?.updateMapTiles(updates);
        },
        getInput: () => {
            return sceneInstance.current?.getInputState() || [0, 0];
        },
        setUINicknameVisible: (visible) => {
            sceneInstance.current?.setUINicknameVisible(visible);
        },
        setUIPlayerNumVisible: (visible) => {
            sceneInstance.current?.setUIPlayerNumVisible(visible);
        }
    }));

    useEffect(() => {
        if (!gameContainer.current) return;

        const scene = new GameScene();
        sceneInstance.current = scene;

        const config = {
            type: Phaser.AUTO,
            width,
            height,
            parent: gameContainer.current,
            scene: scene,
            physics: {
                default: false
            }
        };

        const game = new Phaser.Game(config);

        game.events.once("ready", () => {
            game.scene.start("GameScene", {
                tilesUrl: tilesImage,
            });

            scene.setSettingsRef(settingsRef);
            scene.onReadyCallback = onGameReady;
            if (onSkillUse) {
                scene.onSkillKey = onSkillUse;
            }
        });

        return () => {
            game.destroy(true);
        };
     }, []);

     const boxStyle = {
        position: "absolute",
        left: x,
        top: y,
        width: `${width}px`,
        height: `${height}px`,
        overflow: "hidden",
        transform: "translate(-50%, -50%)"
     }

     return <div ref={gameContainer} style={boxStyle} />;
})