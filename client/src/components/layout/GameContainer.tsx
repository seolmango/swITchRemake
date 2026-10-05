import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { Color } from '../../theme/color.ts';
import { GAME_DESIGN_HEIGHT, GAME_DESIGN_WIDTH, gameCanvasScale } from './gameScale.ts';

import { GameContainerScaleContext } from './gameContainerContext.ts';
import { ROTATED_STYLE, setRotated, shouldForceLandscape, tryLockLandscape, useRotated } from './forcedLandscape.ts';

interface GameContainerProps {
    children: React.ReactNode;
    fillFactor?: number;
    isPopup?: boolean;
    zIndex?: number;
    responsiveForm?: boolean;
    /** 대기실·경기·결과. 세로로 든 폰에서도 가로로 돌려 그린다(forcedLandscape.ts). */
    forceLandscape?: boolean;
}

export const GameContainer: React.FC<GameContainerProps> = ({
                                                                children,
                                                                fillFactor = 1.0,
                                                                isPopup = false,
                                                                responsiveForm = false,
                                                                forceLandscape = false,
                                                                zIndex = 1
                                                            }) => {
    const [scale, setScale] = useState(1);
    const theme = useSettingsStore((state) => state.theme);
    const rotated = useRotated() && forceLandscape && !isPopup;

    useEffect(() => {
        if (forceLandscape && !isPopup) tryLockLandscape();
        const handleResize = () => {
            const viewport = window.visualViewport;
            const width = viewport?.width ?? window.innerWidth;
            const height = viewport?.height ?? window.innerHeight;
            const rotate = forceLandscape && shouldForceLandscape(width, height);
            if (!isPopup) setRotated(rotate);
            const portraitMenu = responsiveForm && window.matchMedia('(max-width: 640px) and (orientation: portrait)').matches;
            // 돌린 화면은 폭과 높이가 뒤바뀐 화면이다. 축소 배율도 그 기준으로 잰다.
            setScale(portraitMenu ? 1 : gameCanvasScale(rotate ? height : width, rotate ? width : height, fillFactor));
        };
        window.addEventListener('resize', handleResize);
        window.visualViewport?.addEventListener('resize', handleResize);
        handleResize();
        return () => {
            window.removeEventListener('resize', handleResize);
            window.visualViewport?.removeEventListener('resize', handleResize);
            if (!isPopup) setRotated(false);
        };
    }, [fillFactor, responsiveForm, forceLandscape, isPopup]);

    const canvasBgColor = theme === 0 ? Color.white : Color.black;

    return (
        <div className={responsiveForm ? 'game-container responsive-form-container' : 'game-container'} style={{
            width: '100vw',
            height: '100dvh',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            position: isPopup ? 'absolute' : 'relative',
            top: 0,
            left: 0,
            backgroundColor: isPopup ? 'transparent' : Color.letterbox,
            zIndex: zIndex,
            pointerEvents: isPopup ? 'none' : 'auto',
            overflow: 'clip',
            ...(rotated ? ROTATED_STYLE : {}),
        }}>
            <div className="game-stage" style={{
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
