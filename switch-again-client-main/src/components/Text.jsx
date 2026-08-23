import React from "react";

export const Text = ({
    textContent,
    x,
    y,
    fontSize,
    color,
    style
}) => {
    const isAbsolute = x !== undefined && y !== undefined;

    const containerStyle = {
        display: "inline-flex",
        flexDirection: "column",
        alignItems: 'center',
        userSelect: "none",
        position: isAbsolute ? "absolute" : "relative",
        left: isAbsolute ? `${x}px` : undefined,
        top: isAbsolute ? `${y}px` : undefined,
        transform: isAbsolute ? "translate(-50%, -50%)" : undefined,
        ...style,
    };

    const textStyle = {
        color: color,
        fontSize: `${fontSize}px`,
        textAlign: "center",
    };

    return (
        <div style={containerStyle} onClick={(e) => e.stopPropagation()}>
            <div style={textStyle}>{textContent}</div>
        </div>
    );
}