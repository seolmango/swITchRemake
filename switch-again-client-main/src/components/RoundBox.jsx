import React from "react";
import { BUTTON_PALETTE } from "../constants/palette";

export const RoundBox = ({ width, height, type, x, y, children, style }) => {
    const getColors = (typeValue) => {
        switch (typeValue) {
            case 0: return {
                bg: BUTTON_PALETTE.RED.BG,
                stroke: BUTTON_PALETTE.RED.STROKE,
                hover: BUTTON_PALETTE.RED.HOVER_STROKE
            };
            case 1: return {
                bg: BUTTON_PALETTE.BLUE.BG,
                stroke: BUTTON_PALETTE.BLUE.STROKE,
                hover: BUTTON_PALETTE.BLUE.HOVER_STROKE
            };
            case 2: return {
                bg: BUTTON_PALETTE.GRAY.BG,
                stroke: BUTTON_PALETTE.GRAY.STROKE,
                hover: BUTTON_PALETTE.GRAY.HOVER_STROKE
            };
        }
    };

    const colors = getColors(type);

    const isAbsolute = x !== undefined && y !== undefined;

    const boxStyle = {
        width: `${width}px`,
        height: `${height}px`,
        backgroundColor: colors.bg,
        border: `10px solid ${colors.stroke}`,
        borderRadius: "25px",
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",

        position: isAbsolute ? "absolute" : "relative",
        left: isAbsolute ? `${x}px` : undefined,
        top: isAbsolute ? `${y}px` : undefined,
        transform: isAbsolute ? "translate(-50%, -50%)" : undefined,
        
        ...style
    };

    return <div style={boxStyle} onClick={(e) => e.stopPropagation()}>{children}</div>;
}