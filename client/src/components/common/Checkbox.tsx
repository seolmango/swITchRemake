import React from 'react';
import { Icon } from './Icon.tsx';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { Color, themeColors } from '../../theme/color.ts';

interface CheckboxProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
}

export const Checkbox: React.FC<CheckboxProps> = ({ checked, onChange, label }) => {
    const theme = useSettingsStore((state) => state.theme);
    return (
        <button type="button" role="checkbox" aria-checked={checked} onClick={() => onChange(!checked)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 20, border: 0, background: 'transparent',
            color: themeColors(theme).text, fontSize: 34, cursor: 'pointer',
        }}>
            <span style={{
                width: 54, height: 54, display: 'grid', placeItems: 'center', boxSizing: 'border-box',
                borderRadius: 13, border: `6px solid ${checked ? Color.blue[2] : themeColors(theme).panelBorder}`,
                color: theme === 0 ? Color.black : Color.blue[2], background: theme === 0 && checked ? Color.blue[0] : 'transparent',
            }}>{checked && <Icon name="check" size={38}/>}</span>
            {label}
        </button>
    );
};
