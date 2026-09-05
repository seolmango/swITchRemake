import React from 'react';
import { Icon } from './Icon.tsx';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { Color, statusInkColors, themeColors } from '../../theme/color.ts';

interface CheckboxProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
}

export const Checkbox: React.FC<CheckboxProps> = ({ checked, onChange, label }) => {
    const theme = useSettingsStore((state) => state.theme);
    const infoInk = statusInkColors(theme).info;
    return (
        <button type="button" className="round-checkbox" role="checkbox" aria-checked={checked} onClick={() => onChange(!checked)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 20, border: 0, background: 'transparent',
            color: themeColors(theme).text, fontSize: 34, cursor: 'pointer',
        }}>
            <span style={{
                width: 54, height: 54, display: 'grid', placeItems: 'center', boxSizing: 'border-box',
                borderRadius: 13, border: `6px solid ${checked ? infoInk : themeColors(theme).panelBorder}`,
                color: theme === 0 ? Color.black : infoInk, background: theme === 0 && checked ? Color.blue[0] : 'transparent',
            }}>{checked && <Icon name="check" size={38}/>}</span>
            {label}
        </button>
    );
};
