import React, { useEffect, useRef, useState } from 'react';
import type { Theme } from '../types.ts';
import type { HudAlert } from './hudTypes.ts';
import { Color } from '../../theme/color.ts';
import { HUD_FONT, HUD_METRICS, bodyText, panel } from './hudTheme.ts';

interface Props {
    theme: Theme;
    alerts: readonly HudAlert[];
    /** Pushes the stack down when a standing warning already occupies the top-centre slot. */
    offsetTop: number;
}

const LIFETIME_MS = 3400;
const MAX_VISIBLE = 3;

/**
 * Transient notifications. The caller provides a bounded recent feed; this component remembers ids that
 * are still in that feed and drops each visible notification after `LIFETIME_MS`.
 *
 * Doing expiry here rather than in the caller means a message can't be cut short by an unrelated state
 * push, and the caller never has to run timers just to make text disappear.
 */
export const AlertStack: React.FC<Props> = ({ theme, alerts, offsetTop }) => {
    const [visible, setVisible] = useState<HudAlert[]>([]);
    const seenRef = useRef(new Set<number>());
    const timersRef = useRef(new Map<number, number>());

    useEffect(() => {
        const currentIds = new Set(alerts.map((alert) => alert.id));
        for (const id of seenRef.current) {
            if (!currentIds.has(id)) seenRef.current.delete(id);
        }
        const fresh = alerts.filter((a) => !seenRef.current.has(a.id));
        if (fresh.length === 0) return;
        for (const a of fresh) seenRef.current.add(a.id);

        setVisible((prev) => [...prev, ...fresh].slice(-MAX_VISIBLE));

        for (const a of fresh) {
            const timer = window.setTimeout(() => {
                setVisible((prev) => prev.filter((v) => v.id !== a.id));
                timersRef.current.delete(a.id);
            }, LIFETIME_MS);
            timersRef.current.set(a.id, timer);
        }
    }, [alerts]);

    useEffect(() => () => {
        for (const timer of timersRef.current.values()) window.clearTimeout(timer);
        timersRef.current.clear();
    }, []);

    if (visible.length === 0) return null;

    return (
        <div style={{
            position: 'absolute', top: offsetTop, left: '50%', transform: 'translateX(-50%)',
            display: 'flex', flexDirection: 'column', gap: 9, alignItems: 'center',
            fontFamily: HUD_FONT, pointerEvents: 'none',
        }}>
            {visible.map((a) => (
                <div
                    key={a.id}
                    style={a.tone === 'danger'
                        ? {
                            padding: '11px 21px', borderRadius: HUD_METRICS.controlRadius, whiteSpace: 'nowrap',
                            background: Color.red[2], color: Color.white, fontSize: HUD_METRICS.bodyFont, fontWeight: 800,
                            boxShadow: `0 3px 14px color-mix(in srgb, ${Color.red[2]} 48%, transparent)`,
                        }
                        : {
                            ...panel(theme), padding: '11px 21px', whiteSpace: 'nowrap',
                            color: bodyText(theme), fontSize: HUD_METRICS.bodyFont, fontWeight: 700,
                        }}
                >{a.text}</div>
            ))}
        </div>
    );
};
