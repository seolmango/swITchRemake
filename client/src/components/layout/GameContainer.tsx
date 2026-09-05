import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { Color } from '../../theme/color.ts';

const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1080;

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
            const scaleX = window.innerWidth / DESIGN_WIDTH;
            const scaleY = window.innerHeight / DESIGN_HEIGHT;
            setScale(Math.min(scaleX, scaleY) * fillFactor);
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
                width: `${DESIGN_WIDTH}px`,
                height: `${DESIGN_HEIGHT}px`,
                transform: `scale(${scale})`,
                transformOrigin: 'center center',
                flexShrink: 0,
                position: 'relative',
                backgroundColor: isPopup ? 'transparent' : canvasBgColor,
                color: theme === 0 ? Color.black : Color.white,
                pointerEvents: 'auto',
                transition: 'background-color 0.3s ease'
            }}>
                {children}
            </div>
        </div>
    );
};
