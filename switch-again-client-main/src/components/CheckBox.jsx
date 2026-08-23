import React, { useState } from "react";
import { BUTTON_PALETTE } from "../constants/palette";

export const Checkbox = ({
                                  size = 30,
                                  checked,
                                  onChange,
                                  x,
                                  y,
                              }) => {
    const [isHover, setIsHover] = useState(false);

    const isAbsolute = x !== undefined && y !== undefined;
    const scaleValue = isHover ? 1.05 : 1;

    const containerStyle = {
        width: `${size}px`,
        height: `${size}px`,
        position: isAbsolute ? "absolute" : "relative",
        left: isAbsolute ? `${x}px` : undefined,
        top: isAbsolute ? `${y}px` : undefined,
        transform: isAbsolute
            ? `translate(-50%, -50%) scale(${scaleValue})`
            : `scale(${scaleValue})`,
        transition: "transform 100ms ease",
        cursor: "pointer",
        userSelect: "none",
    };

    const boxStyle = {
        width: "100%",
        height: "100%",
        borderRadius: "6px",
        border: `4px solid ${BUTTON_PALETTE.GRAY.STROKE}`,
        backgroundColor: "#ffffff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "all 150ms ease",
    };

    const innerSize = size * 0.5;

    const innerStyle = {
        width: `${innerSize}px`,
        height: `${innerSize}px`,
        backgroundColor: checked
            ? BUTTON_PALETTE.BLUE.STROKE
            : BUTTON_PALETTE.RED.STROKE,
        transition: "background-color 150ms ease",
    };

    return (
        <div
            style={containerStyle}
            onMouseEnter={() => setIsHover(true)}
            onMouseLeave={() => setIsHover(false)}
            onClick={(e) => {
                e.stopPropagation();
                onChange(!checked);
            }}
        >
            <div style={boxStyle}>
                <div style={innerStyle} />
            </div>
        </div>
    );
};