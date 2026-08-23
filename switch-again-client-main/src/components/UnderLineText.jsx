import React, { useState } from "react";

export const UnderLineText = ({
    textContent,
    x, 
    y,
    align,
    fontSize,
    defaultColor,
    hoverColor,
    strokeWidth,
    onClick,
    style
}) => {
    const [isHovered, setIsHovered] = useState(false);

    const currentColor = isHovered ? hoverColor : defaultColor;
    const isAbsolute = x !== undefined && y !== undefined;

    const containerStyle = {
        display: "inline-flex",
        flexDirection: "column",
        alignItems: 'center',
        cursor: onClick ? "pointer" : "default",
        userSelect: "none",

        position: isAbsolute ? "absolute" : "relative",
        left: isAbsolute ? `${x}px` : undefined,
        top: isAbsolute ? `${y}px` : undefined,
        transform: isAbsolute ? "translate(-50%, -50%)" : undefined,

        ...style,
    };

    const textStyle = {
        color: currentColor,
        fontSize: `${fontSize}px`,
        textAlign: align,
        margin: 0,
    };

    const underlineStyle = {
        width: "100%",
        height: `${strokeWidth}px`,
        backgroundColor: currentColor,
        borderRadius: `${strokeWidth / 2}px`,
        margin:0
    };

    return (
        <div
            style={containerStyle}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onClick={(e) => {
                e.stopPropagation();
                if (onClick) onClick();
            }}
        >
            <div style={textStyle}>{textContent}</div>
            <div style={underlineStyle} />
        </div>
    );
}