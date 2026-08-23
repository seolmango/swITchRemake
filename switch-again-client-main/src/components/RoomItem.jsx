import React, { useState, useMemo } from "react";
import { BUTTON_PALETTE } from "../constants/palette";
import { IoIosContact, IoMdUnlock, IoMdLock } from "react-icons/io";
import AutoScaleText from "./AutoScaleText";

export const RoomItem = ({ info, onClick, x, y }) => {
    const [isHover, setIsHover] = useState(false);

    const colors = useMemo(() => {
        if (isHover) {
            return {
                bg: BUTTON_PALETTE.GRAY.STROKE,
                stroke: BUTTON_PALETTE.GRAY.HOVER_STROKE,
                text: BUTTON_PALETTE.TEXT.HOVER,
            };
        }
        return {
            bg: BUTTON_PALETTE.GRAY.BG,
            stroke: BUTTON_PALETTE.GRAY.STROKE,
            text: BUTTON_PALETTE.TEXT.DEFAULT,
        };
    }, [isHover]);

    const isAbsolute = x !== undefined && y !== undefined;

    const containerStyle = {
        width: "750px",
        height: "185px",
        borderRadius: "25px",
        backgroundColor: colors.bg,
        border: `10px solid ${colors.stroke}`,
        boxSizing: "border-box",
        padding: "15px 25px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        cursor: "pointer",
        userSelect: "none",
        position: isAbsolute ? "absolute" : "relative",
        left: isAbsolute ? `${x}px` : undefined,
        top: isAbsolute ? `${y}px` : undefined,
        transform: isAbsolute
            ? `translate(-50%, -50%) ${isHover ? "scale(1.03)" : "scale(1)"}`
            : isHover ? "scale(1.03)" : "scale(1)",
        transition: "all 200ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
        boxShadow: isHover ? "0 10px 20px rgba(0,0,0,0.2)" : "none",
        zIndex: isHover ? 10 : 1,
    };

    const rowStyle = {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        width: "100%",
    };

    return (
        <div
            style={containerStyle}
            onMouseEnter={() => setIsHover(true)}
            onMouseLeave={() => setIsHover(false)}
            onClick={(e) => {
                e.stopPropagation();
                if (onClick) onClick();
            }}
        >
            <div style={rowStyle}>
                <AutoScaleText
                    text={info.room_name}
                    maxFontSize={48}
                    maxWidth={500}
                    color={colors.text}
                />
                <span style={{
                    fontSize: "35px",
                    color: BUTTON_PALETTE.TEXT.HOVER,
                    opacity: 0.8,
                    flexShrink: 0
                }}>
                    #{info.room_id}
                </span>
            </div>

            <div style={rowStyle}>
                <AutoScaleText
                    text={info.owner_name}
                    maxFontSize={38}
                    maxWidth={350}
                    color={colors.text}
                />

                <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "15px",
                    fontSize: "36px",
                    color: colors.text,
                    flexShrink: 0
                }}>
                    <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <IoIosContact size={42}/> {info.player_count}
                    </span>

                    {info.password_exist ? <IoMdLock size={38}/> : <IoMdUnlock size={38} opacity={0.5}/>}

                    <span style={{
                        color: colors.text,
                        fontSize: "28px",
                        fontWeight: "bold",
                        textTransform: "uppercase"
                    }}>
                        {info.room_status ? "playing" : "waiting"}
                    </span>
                </div>
            </div>
        </div>
    );
};