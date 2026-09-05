import React, { useState } from 'react';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { statusInkColors, themeColors } from '../../theme/color.ts';

interface InlineLinkProps {
    children: React.ReactNode;
    onClick: () => void;
    style?: React.CSSProperties;
}

export const InlineLink: React.FC<InlineLinkProps> = ({ children, onClick, style }) => {
    const theme = useSettingsStore((state) => state.theme);
    const [hover, setHover] = useState(false);
    const infoInk = statusInkColors(theme).info;
    return (
        <button type="button" className="inline-link" onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{
            border: 0,
            borderBottom: `5px solid ${hover ? infoInk : themeColors(theme).muted}`,
            background: 'transparent',
            color: hover ? infoInk : themeColors(theme).text,
            cursor: 'pointer',
            fontSize: 31,
            lineHeight: 1.15,
            transform: hover ? 'scale(1.025)' : 'none',
            transition: 'transform 160ms ease, color 160ms ease, border-color 160ms ease',
            ...style,
        }}>{children}</button>
    );
};
