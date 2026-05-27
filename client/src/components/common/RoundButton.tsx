import React, { useState, useMemo, useCallback } from "react";
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

    const isActive = (isHovered || isFocused) && !disabled;

    const transformValue = isActive ? 'translate(-50%, -50%) scale(1.05)' : 'translate(-50%, -50%)';

    const { currentBg, currentStroke, currentTextColor } = useMemo(() => {
        const colorArray = type === 0 ? Color.red : type === 1 ? Color.blue : Color.gray;
        const bg = theme === 0 ? (isActive ? colorArray[1] : colorArray[0]) : 'transparent';
        const stroke = isActive ? colorArray[2] : colorArray[1];
        const textColor = theme === 0 ? Color.black : stroke;

        return { currentBg: bg, currentStroke: stroke, currentTextColor: textColor };
    }, [type, theme, isActive]);

    const finalSize = useMemo(() => {
        const innerWidth = width - 20;
        const innerHeight = height - 20;

        if (typeof content === 'string') {
            const estimatedCharWidth = 0.6;
            const maxByWidth = innerWidth / Math.max(content.length * estimatedCharWidth, 1);
            const maxByHeight = innerHeight * 0.8;
            return Math.min(maxByWidth, maxByHeight) * textSizeRatio;
        }

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
                <span style={{
                    fontSize: `${finalSize}px`,
                    color: currentTextColor,
                    transition: 'color 0.2s ease-out',
                    lineHeight: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }}>
                    {content}
                </span>
            ) : (
                React.cloneElement(content as React.ReactElement<{ size?: number; style?: React.CSSProperties }>, {
                    size: finalSize,
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