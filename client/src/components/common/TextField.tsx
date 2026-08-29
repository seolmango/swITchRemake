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
    const labelId = `${id}-label`;
    const helpId = `${id}-help`;

    return (
        <label className="field-group" htmlFor={id}>
            <span className="field-label" id={labelId}>{label}</span>
            <input
                {...props}
                ref={ref}
                id={id}
                value={value}
                disabled={disabled}
                /*
                 * 감싸는 `<label>`은 안에 있는 글자를 **전부** 이름으로 삼는다. 그래서 오류나
                 * 힌트가 뜨는 순간 이 칸의 이름이 "닉네임"에서 "닉네임 2~12자 영문·숫자·한글만
                 * 사용할 수 있습니다."로 바뀌어 버린다 — 스크린리더는 이름과 설명을 두 번 읽고,
                 * 이름으로 칸을 찾는 코드는 칸을 잃는다. 이름은 라벨만, 설명은 도움말만.
                 */
                aria-labelledby={labelId}
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
