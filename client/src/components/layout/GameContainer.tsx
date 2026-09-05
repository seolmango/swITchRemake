import React, { createContext, useContext, useEffect, useState } from 'react';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { Color } from '../../theme/color.ts';
import { GAME_DESIGN_HEIGHT, GAME_DESIGN_WIDTH, gameCanvasScale } from './gameScale.ts';

const GameContainerScaleContext = createContext(1);

/** Actual transform applied to the fixed design stage. Portalled controls intentionally ignore it. */
export const useGameContainerScale = (): number => useContext(GameContainerScaleContext);

interface GameContainerProps {
    children: React.ReactNode;
    fillFactor?: number;
    isPopup?: boolean;
    zIndex?: number;
}

export const GameContainer: React.FC<GameContainerProps> = ({
                                                                children,
                                                                fillFactor = 1.0,
                                                                isPopup = false,
                                                                zIndex = 1
                                                            }) => {
    const [scale, setScale] = useState(1);
    const theme = useSettingsStore((state) => state.theme);

    useEffect(() => {
        const handleResize = () => {
            setScale(gameCanvasScale(window.innerWidth, window.innerHeight, fillFactor));
        };
        window.addEventListener('resize', handleResize);
        handleResize();
        return () => window.removeEventListener('resize', handleResize);
    }, [fillFactor]);

    const canvasBgColor = theme === 0 ? Color.white : Color.black;

    return (
        <div style={{
            width: '100vw',
            height: '100vh',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            position: isPopup ? 'absolute' : 'relative',
            top: 0,
            left: 0,
            backgroundColor: isPopup ? 'transparent' : Color.letterbox,
            zIndex: zIndex,
            pointerEvents: isPopup ? 'none' : 'auto',
            overflow: 'clip'
        }}>
            <div style={{
                width: `${GAME_DESIGN_WIDTH}px`,
                height: `${GAME_DESIGN_HEIGHT}px`,
                transform: `scale(${scale})`,
                transformOrigin: 'center center',
                flexShrink: 0,
                position: 'relative',
                backgroundColor: isPopup ? 'transparent' : canvasBgColor,
                color: theme === 0 ? Color.black : Color.white,
                pointerEvents: 'auto',
                transition: 'background-color 0.3s ease'
            }}>
                <GameContainerScaleContext.Provider value={scale}>
                    {children}
                </GameContainerScaleContext.Provider>
            </div>
        </div>
    );
};
