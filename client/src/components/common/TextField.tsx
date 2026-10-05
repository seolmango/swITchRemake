import React, { forwardRef, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { statusInkColors, themeColors } from '../../theme/color.ts';

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
    const statusInk = statusInkColors(theme);
    const id = useId();
    const [focused, setFocused] = useState(false);
    const [revealed, setRevealed] = useState(false);
    const { t } = useTranslation();
    const isPassword = props.type === 'password';
    // Disabling a field ends the hold, including when it is enabled again later.
    if (disabled && revealed) setRevealed(false);
    useEffect(() => {
        const hide = () => setRevealed(false);
        window.addEventListener('blur', hide);
        document.addEventListener('visibilitychange', hide);
        return () => { window.removeEventListener('blur', hide); document.removeEventListener('visibilitychange', hide); };
    }, []);
    const labelId = `${id}-label`;
    const helpId = `${id}-help`;

    return (
        <div className="field-group">
            <label className="field-label" id={labelId} htmlFor={id}>{label}</label>
            <div style={{ position: 'relative', minWidth: 0 }}>
            <input
                {...props}
                type={isPassword && revealed && !disabled ? 'text' : props.type}
                ref={ref}
                id={id}
                value={value}
                disabled={disabled}
                /*
                 * 이름은 라벨만, 설명은 도움말만 연결한다. 오류나 힌트가 바뀌어도
                 * 입력의 접근성 이름은 유지하고 표시 버튼은 별도 이름을 사용한다.
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
                    borderBottom: `var(--border) solid ${error ? statusInk.bad : focused ? statusInk.info : colors.panelBorder}`,
                    borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
                    outline: 'none',
                    padding: isPassword ? '6px 90px 0 20px' : '6px 20px 0',
                    background: disabled ? 'transparent' : colors.field,
                    color: colors.text,
                    opacity: disabled ? 0.45 : 1,
                    fontSize: 32,
                    transition: 'border-color 160ms ease, background 160ms ease',
                }}
            />
            {isPassword && <button
                type="button"
                disabled={disabled}
                aria-label={t('auth.holdToRevealPassword')}
                title={t('auth.holdToRevealPassword')}
                aria-pressed={revealed && !disabled}
                onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setRevealed(true);
                }}
                onPointerUp={() => setRevealed(false)}
                onPointerCancel={() => setRevealed(false)}
                onLostPointerCapture={() => setRevealed(false)}
                onBlur={() => setRevealed(false)}
                onKeyDown={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); setRevealed(true); } }}
                onKeyUp={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); setRevealed(false); } }}
                style={{ position: 'absolute', right: 10, top: 10, width: 62, height: 48, border: `var(--border-thin) solid ${colors.panelBorder}`, borderRadius: 'var(--radius-sm)', background: colors.field, color: colors.text, cursor: 'pointer', touchAction: 'none' }}
            ><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>{revealed && <path d="m3 3 18 18"/>}</svg></button>}
            </div>
            <span id={helpId} className={`field-help${error ? ' is-error' : ''}`} aria-live={error ? 'polite' : undefined} style={{ color: error ? colors.text : colors.muted }}>{error || hint || ''}</span>
        </div>
    );
});

TextField.displayName = 'TextField';
