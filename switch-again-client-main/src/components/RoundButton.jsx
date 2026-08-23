import React, { useState } from "react";
import { BUTTON_PALETTE } from "../constants/palette";

export const RoundButton = ({
    width,
    height,
    type,
    text,
    icon,
    textSize,
    iconSize,
    onClick,
    disabled,
    x,
    y,
    style
}) => {
    const [isHovered, setIsHovered] = useState(false);
    const [isFocused, setIsFocused] = useState(false);

    const getColorSet = (typeValue) => {
        switch (typeValue) {
            case 0: return BUTTON_PALETTE.RED;
            case 1: return BUTTON_PALETTE.BLUE;
            case 2: return BUTTON_PALETTE.GRAY;
        }
    };

    const colors = getColorSet(type);
    const isAbsolute = x !== undefined && y !== undefined;

    const isActive = (isHovered || isFocused) && !disabled;

    let transformValue = '';
    if (isAbsolute) transformValue += 'translate(-50%, -50%) ';
    if (isActive) transformValue += 'scale(1.05)';

    const currentStyle = {
        bg: isActive ? colors.STROKE : colors.BG,
        stroke: isActive ? colors.HOVER_STROKE : colors.STROKE,
        textColor: isActive ? BUTTON_PALETTE.TEXT.HOVER : BUTTON_PALETTE.TEXT.DEFAULT,
        scale: isActive ? 'scale(1.05)' : 'scale(1)',
    }

    const buttonStyle = {
        width: `${width}px`,
        height: `${height}px`,
        backgroundColor: currentStyle.bg,
        border: `10px solid ${currentStyle.stroke}`,
        borderRadius: "25px",
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'all 0.2s ease-out',
        userSelect: 'none',
        outline: 'none',

        position: isAbsolute ? 'absolute' : 'relative',
        left: isAbsolute ? `${x}px` : '0',
        top: isAbsolute ? `${y}px` : '0',
        transform: transformValue.trim() || 'none',
        ...style
    };

    const handleKeyDown = (e) => {
        if (disabled) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
            onClick && onClick();
            
        }
    };

    const handleClick = (e) => {
        if (disabled) return;
        e.stopPropagation();
        if (onClick) {
            e.currentTarget.blur();
            onClick();
        }
    };

    return (
        <div
            style={buttonStyle}
            onMouseEnter={() => !disabled && setIsHovered(true)}
            onMouseLeave={() => !disabled && setIsHovered(false)}
            tabIndex={disabled ? -1 : 0}
            onFocus={() => !disabled && setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
        >
            {icon ? (
                React.cloneElement(icon, {
                    size: iconSize,
                    style: {
                        color: currentStyle.textColor,
                        transition: 'color 0.2s ease-out',
                        display: 'block'
                    }
                })
            ) : (
                <span style={{
                    fontSize: `${textSize}px`,
                    color: currentStyle.textColor,
                    marginTop: `${textSize*0.1}px`,
                    transition: 'color 0.2s ease-out'
                }}>
                    {text}
                </span>
            )}
        </div>
    );
};