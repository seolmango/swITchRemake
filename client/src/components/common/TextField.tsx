import React, { forwardRef, useId, useState } from 'react';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { Color, themeColors } from '../../theme/color.ts';

interface TextFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
    label: string;
    value: string;
    onChange: (value: string) => void;
    error?: string;
    hint?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(({ label, value, onChange, error, hint, disabled, ...props }, ref) => {
    const theme = useSettingsStore((state) => state.theme);
    const colors = themeColors(theme);
    const id = useId();
    const [focused, setFocused] = useState(false);
    const helpId = `${id}-help`;

    return (
        <label className="field-group" htmlFor={id}>
            <span className="field-label">{label}</span>
            <input
                {...props}
                ref={ref}
                id={id}
                value={value}
                disabled={disabled}
                aria-invalid={Boolean(error)}
                aria-describedby={helpId}
                onFocus={(event) => { setFocused(true); props.onFocus?.(event); }}
                onBlur={(event) => { setFocused(false); props.onBlur?.(event); }}
                onChange={(event) => onChange(event.target.value)}
                style={{
                    width: '100%',
                    height: 72,
                    boxSizing: 'border-box',
                    border: 0,
                    borderBottom: `6px solid ${error ? Color.red[2] : focused ? Color.blue[2] : colors.panelBorder}`,
                    borderRadius: '18px 18px 4px 4px',
                    outline: 'none',
                    padding: '6px 20px 0',
                    background: disabled ? 'transparent' : colors.field,
                    color: colors.text,
                    opacity: disabled ? 0.45 : 1,
                    fontSize: 32,
                    transition: 'border-color 160ms ease, background 160ms ease',
                }}
            />
            <span id={helpId} className="field-help" aria-live={error ? 'polite' : undefined} style={{ color: error ? Color.red[2] : colors.muted }}>{error || hint || ''}</span>
        </label>
    );
});

TextField.displayName = 'TextField';
