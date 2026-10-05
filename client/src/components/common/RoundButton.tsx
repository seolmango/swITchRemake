import React, { useState, useMemo, useCallback, useRef, useLayoutEffect } from "react";
import { Color, themeColors } from "../../theme/color.ts";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { playSfx } from "../../audio/sfxPlayer.ts";

interface RoundButtonProps {
    x?: number;
    y?: number;
    width: number;
    height: number;
    type: 0 | 1 | 2;
    content: string | React.ReactElement;
    onClick?: () => void;
    disabled?: boolean;
    isLoading?: boolean;
    style?: React.CSSProperties;
    ariaLabel?: string;
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
                                                             style,
                                                             ariaLabel
                                                         }) => {
    const theme = useSettingsStore((state) => state.theme);
    const [isHovered, setIsHovered] = useState(false);
    const [isFocused, setIsFocused] = useState(false);
    const [calculatedSize, setCalculatedSize] = useState(0);
    const measureRef = useRef<HTMLSpanElement>(null);

    const isActive = (isHovered || isFocused) && !disabled;
    const focusColor = themeColors(theme).focus;

    const { currentBg, currentStroke, currentTextColor } = useMemo(() => {
        const colorArray = type === 0 ? Color.red : type === 1 ? Color.blue : Color.gray;
        const stroke = type === 0 ? 'var(--ui-red-border)' : type === 1 ? 'var(--ui-blue-border)' : 'var(--ui-neutral-border)';
        // 다크는 테두리만 남기되 채움은 바탕색으로 막는다(투명이면 팝업·HUD 아래가 비친다).
        // 손이 가면 크기를 키우지 않고 채움만 바꾼다.
        const bg = theme === 0
            ? (isActive ? colorArray[1] : colorArray[0])
            : (isActive ? `color-mix(in srgb, ${stroke} 16%, var(--theme-canvas))` : 'var(--theme-canvas)');
        const textColor = theme === 0 ? Color.black : Color.white;

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

        const fittedSize = 100 * Math.min(scaleX, scaleY);
        setCalculatedSize(Math.min(fittedSize, height * 0.48));
    }, [content, width, height]);

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
        return Math.min(innerWidth, innerHeight) * 0.68;
    }, [width, height, content]);

    const buttonStyle: React.CSSProperties = useMemo(() => ({
        position: x !== undefined && y !== undefined ? 'absolute' : 'relative',
        left: x !== undefined ? `${x}px` : undefined,
        top: y !== undefined ? `${y}px` : undefined,
        width: `${width}px`,
        height: `${height}px`,
        backgroundColor: currentBg,
        border: `var(--border) solid ${currentStroke}`,
        borderRadius: 'var(--radius-md)',
        boxSizing: "border-box",
        // The invisible 100px measuring span must not widen a scrollable mobile menu.
        overflow: 'hidden',
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? 'not-allowed' : (isLoading ? 'wait' : 'pointer'),
        opacity: (disabled || isLoading) ? 0.65 : 1,
        outline: isFocused ? `var(--focus-width) solid ${focusColor}` : 'var(--focus-width) solid transparent',
        outlineOffset: 'var(--focus-offset)',
        transition: 'background-color var(--motion-fast) ease-out, border-color var(--motion-fast) ease-out',
        userSelect: 'none',
        transform: x !== undefined && y !== undefined ? 'translate(-50%, -50%)' : 'none',
        ...style
    }), [x, y, width, height, currentBg, currentStroke, focusColor, disabled, isLoading, isFocused, style]);

    // 눌린 버튼만 소리를 낸다. 막힌 버튼은 조용한 것이 맞다 — 아무 일도 안 일어났기 때문이다.
    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
        if (disabled || isLoading) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
            playSfx('ui-click');
            onClick?.();
        }
    }, [disabled, isLoading, onClick]);

    const handleClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
        if (disabled || isLoading) return;
        e.stopPropagation();
        e.currentTarget.blur();
        playSfx('ui-click');
        onClick?.();
    }, [disabled, isLoading, onClick]);

    return (
        <button
            className="round-button"
            type="button"
            disabled={disabled || isLoading}
            aria-busy={isLoading || undefined}
            aria-label={ariaLabel ?? (typeof content === 'string' ? content : undefined)}
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
                        aria-hidden="true"
                        ref={measureRef}
                        style={{
                            position: 'absolute',
                            visibility: 'hidden',
                            fontSize: '100px',
                            whiteSpace: 'nowrap',
                            lineHeight: 1,
                            fontFamily: 'var(--font-display)',
                        }}
                    >
                        {content}
                    </span>
                    {calculatedSize > 0 && (
                        <svg
                            width="100%"
                            height="100%"
                            aria-hidden="true"
                            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
                        >
                            <text
                                x="50%"
                                y="50%"
                                textAnchor="middle"
                                dominantBaseline="central"
                                fill={currentTextColor}
                                fontSize={`${calculatedSize}px`}
                                fontFamily="var(--font-display)"
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
        </button>
    );
});
