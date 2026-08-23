import { useState, useRef, useEffect } from "react";

export default function AutoScaleText ({ text, maxFontSize, maxWidth, color, fontWeight = "normal" }) {
    const textRef = useRef(null);
    const [scale, setScale] = useState(1);

    useEffect(() => {
        if (textRef.current) {
            const actualWidth = textRef.current.offsetWidth;
            if (actualWidth > maxWidth) {
                setScale(maxWidth / actualWidth);
            } else {
                setScale(1);
            }
        }
    }, [text, maxWidth]);

    return (
        <div style={{
            width: `${maxWidth}px`,
            overflow: "hidden",
            whiteSpace: "nowrap",
            flexShrink: 0
        }}>
            <span
                ref={textRef}
                style={{
                    display: "inline-block",
                    fontSize: `${maxFontSize}px`,
                    color: color,
                    fontWeight: fontWeight,
                    transformOrigin: "left center",
                    transform: `scale(${scale})`,
                    whiteSpace: "nowrap",
                    transition: "transform 0.1s ease",
                }}
            >
                {text}
            </span>
        </div>
    );
};