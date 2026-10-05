import React from 'react';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { toneColors, type ThemeTone } from '../../theme/color.ts';

interface RoundBoxProps {
    width: number;
    height: number;
    type?: 0 | 1 | 2;
    x?: number;
    y?: number;
    children?: React.ReactNode;
    style?: React.CSSProperties;
}

export const RoundBox: React.FC<RoundBoxProps> = ({ width, height, type = 2, x, y, children, style }) => {
    const theme = useSettingsStore((state) => state.theme);
    const tone: ThemeTone = type === 0 ? 'red' : type === 1 ? 'blue' : 'gray';
    const ramp = toneColors(tone);
    const border = type === 0 ? 'var(--ui-red-border)' : type === 1 ? 'var(--ui-blue-border)' : 'var(--ui-neutral-border)';
    const absolute = x !== undefined && y !== undefined;
    return (
        <div className="round-box" style={{
            width,
            height,
            boxSizing: 'border-box',
            borderRadius: 'var(--radius-lg)',
            border: `var(--border) solid ${border}`,
            background: theme === 0 ? ramp[0] : 'var(--theme-canvas)',
            position: absolute ? 'absolute' : 'relative',
            left: x,
            top: y,
            transform: absolute ? 'translate(-50%, -50%)' : undefined,
            transition: 'background 180ms ease, border-color 180ms ease',
            ...style,
        }}>
            {children}
        </div>
    );
};
