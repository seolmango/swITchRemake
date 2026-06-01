import React, { useState, useMemo, useCallback, useRef, useLayoutEffect } from "react";
import { Color } from "../../theme/color.ts";
import { useSettingsStore } from "../../stores/useSettingsStore";

interface RoundButtonProps {
    x: number;
    y: number;
    width: number;
    height: number;
    type: 0 | 1 | 2;
    content: string | React.ReactElement;
    onClick?: () => void;
    disabled?: boolean;
    isLoading?: boolean;
    style?: React.CSSProperties;
}

export const RoundButton = React.memo<RoundButtonProps>(({
                                                             x,
                                                             y,
                                                             width,
                                                             height,
                                                             type,
                                                             content,
                                                             onClick,
                                                             disabled = false,
                                                             isLoading = false,
                                                             style
                                                         }) => {
    const { theme, textSizeRatio } = useSettingsStore();
    const [isHovered, setIsHovered] = useState(false);
    const [isFocused, setIsFocused] = useState(false);
    const [calculatedSize, setCalculatedSize] = useState(0);
    const measureRef = useRef<HTMLSpanElement>(null);

    const isActive = (isHovered || isFocused) && !disabled;

    const transformValue = isActive ? 'translate(-50%, -50%) scale(1.05)' : 'translate(-50%, -50%)';

    const { currentBg, currentStroke, currentTextColor } = useMemo(() => {
        const colorArray = type === 0 ? Color.red : type === 1 ? Color.blue : Color.gray;
        const bg = theme === 0 ? (isActive ? colorArray[1] : colorArray[0]) : 'transparent';
        const stroke = isActive ? colorArray[2] : colorArray[1];
        const textColor = theme === 0 ? Color.black : stroke;

        return { currentBg: bg, currentStroke: stroke, currentTextColor: textColor };
    }, [type, theme, isActive]);

    const calculateSize = useCallback(() => {
        if (typeof content !== 'string' || !measureRef.current) return;

        const currentWidth = measureRef.current.offsetWidth;
        const currentHeight = measureRef.current.offsetHeight;

        if (currentWidth === 0 || currentHeight === 0) return;

        const innerWidth = width - 30;
        const innerHeight = height - 30;
        const scaleX = innerWidth / currentWidth;
        const scaleY = innerHeight / currentHeight;

        setCalculatedSize(100 * Math.min(scaleX, scaleY) * textSizeRatio);
    }, [content, width, height, textSizeRatio]);

    useLayoutEffect(() => {
        calculateSize();
    }, [calculateSize]);

    React.useEffect(() => {
        if (document.fonts) {
            document.fonts.ready.then(() => {
                calculateSize();
            });
        }
    }, [calculateSize]);

    const iconSize = useMemo(() => {
        if (typeof content === 'string') return 0;
        const innerWidth = width - 30;
        const innerHeight = height - 30;
        return Math.min(innerWidth, innerHeight) * 0.8 * textSizeRatio;
    }, [width, height, content, textSizeRatio]);

    const buttonStyle: React.CSSProperties = useMemo(() => ({
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        width: `${width}px`,
        height: `${height}px`,
        backgroundColor: currentBg,
        border: `10px solid ${currentStroke}`,
        borderRadius: "25px",
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? 'not-allowed' : (isLoading ? 'wait' : 'pointer'),
        opacity: (disabled || isLoading) ? 0.5 : 1,
        transition: 'all 0.2s ease-out',
        userSelect: 'none',
        outline: 'none',
        transform: transformValue,
        ...style
    }), [x, y, width, height, currentBg, currentStroke, disabled, isLoading, transformValue, style]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        if (disabled || isLoading) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
            onClick?.();
        }
    }, [disabled, isLoading, onClick]);

    const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (disabled || isLoading) return;
        e.stopPropagation();
        e.currentTarget.blur();
        onClick?.();
    }, [disabled, isLoading, onClick]);

    return (
        <div
            style={buttonStyle}
            onMouseEnter={() => !disabled && setIsHovered(true)}
            onMouseLeave={() => !disabled && setIsHovered(false)}
            tabIndex={disabled || isLoading ? -1 : 0}
            onFocus={() => !disabled && setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
        >
            {typeof content === 'string' ? (
                <>
                    <span
                        ref={measureRef}
                        style={{
                            position: 'absolute',
                            visibility: 'hidden',
                            fontSize: '100px',
                            whiteSpace: 'nowrap',
                            lineHeight: 1
                        }}
                    >
                        {content}
                    </span>
                    {calculatedSize > 0 && (
                        <svg
                            width="100%"
                            height="100%"
                            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
                        >
                            <text
                                x="50%"
                                y="50%"
                                textAnchor="middle"
                                dominantBaseline="central"
                                fill={currentTextColor}
                                fontSize={`${calculatedSize}px`}
                                style={{ transition: 'fill 0.2s ease-out' }}
                            >
                                {content}
                            </text>
                        </svg>
                    )}
                </>
            ) : (
                React.cloneElement(content as React.ReactElement<{ size?: number; style?: React.CSSProperties }>, {
                    size: iconSize,
                    style: {
                        color: currentTextColor,
                        transition: 'color 0.2s ease-out',
                        display: 'block'
                    }
                })
            )}
        </div>
    );
});