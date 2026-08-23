import React, { useEffect, useRef, useState } from 'react';
import type { Theme } from '../types.ts';
import type { HudAlert } from './hudTypes.ts';
import { Color } from '../../theme/color.ts';
import { HUD_FONT, bodyText, panel } from './hudTheme.ts';

interface Props {
    theme: Theme;
    alerts: readonly HudAlert[];
    /** Pushes the stack down when a standing warning already occupies the top-centre slot. */
    offsetTop: number;
}

const LIFETIME_MS = 3400;
const MAX_VISIBLE = 3;

/**
 * Transient notifications. The caller keeps appending to one feed and never prunes it; this component
 * remembers which ids it has already shown and drops each after `LIFETIME_MS`.
 *
 * Doing expiry here rather than in the caller means a message can't be cut short by an unrelated state
 * push, and the caller never has to run timers just to make text disappear.
 */
export const AlertStack: React.FC<Props> = ({ theme, alerts, offsetTop }) => {
    const [visible, setVisible] = useState<HudAlert[]>([]);
    const seenRef = useRef(new Set<number>());
    const timersRef = useRef<number[]>([]);

    useEffect(() => {
        const fresh = alerts.filter((a) => !seenRef.current.has(a.id));
        if (fresh.length === 0) return;
        for (const a of fresh) seenRef.current.add(a.id);

        setVisible((prev) => [...prev, ...fresh].slice(-MAX_VISIBLE));

        for (const a of fresh) {
            const timer = window.setTimeout(() => {
                setVisible((prev) => prev.filter((v) => v.id !== a.id));
            }, LIFETIME_MS);
            timersRef.current.push(timer);
        }
    }, [alerts]);

    useEffect(() => () => {
        for (const t of timersRef.current) window.clearTimeout(t);
    }, []);

    if (visible.length === 0) return null;

    return (
        <div style={{
            position: 'absolute', top: offsetTop, left: '50%', transform: 'translateX(-50%)',
            display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center',
            fontFamily: HUD_FONT, pointerEvents: 'none',
        }}>
            {visible.map((a) => (
                <div
                    key={a.id}
                    style={a.tone === 'danger'
                        ? {
                            padding: '8px 18px', borderRadius: 12, whiteSpace: 'nowrap',
                            background: Color.red[2], color: Color.white, fontSize: 13, fontWeight: 800,
                            boxShadow: '0 2px 12px rgba(255,113,113,0.45)',
                        }
                        : {
                            ...panel(theme), padding: '8px 18px', whiteSpace: 'nowrap',
                            color: bodyText(theme), fontSize: 13, fontWeight: 700,
                        }}
                >{a.text}</div>
            ))}
        </div>
    );
};
