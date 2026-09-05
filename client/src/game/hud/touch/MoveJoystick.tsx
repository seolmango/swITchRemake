import React, { useCallback, useRef, useState } from 'react';
import type { Theme } from '../../types.ts';
import { Color, statusInkColors } from '../../../theme/color.ts';
import { clearTouchDirection, directionFromOffset, setTouchDirection } from '../../touchInput.ts';

interface Props {
    theme: Theme;
    /** 바깥 원의 지름(px). 손잡이와 중립 구역이 여기서 파생된다. */
    size: number;
}

/** 손가락을 얹어 두기만 한 상태가 이동이 되면 안 된다. 반지름의 이 비율 안쪽은 중립이다. */
const DEAD_ZONE_RATIO = 0.22;

/**
 * 왼손 이동 조이스틱.
 *
 * 8방향이다. 와이어 계약이 상하좌우 4비트라 기울기를 실을 자리가 없고(`shared`의 `InputState`),
 * 이 게임은 이동 속도가 상태(광란·탈진)로만 정해지므로 "살짝 기울여 천천히"가 애초에 없다.
 *
 * 방향은 React state가 아니라 `touchInput` 모듈로 나간다 — 읽는 쪽이 30Hz 타이머라서,
 * 손가락이 움직일 때마다 리렌더를 내면 정작 필요 없는 곳이 초당 수십 번 다시 그려진다.
 * 손잡이 위치만 렌더에 쓴다.
 */
export const MoveJoystick: React.FC<Props> = ({ theme, size }) => {
    const radius = size / 2;
    const knobSize = size * 0.44;
    const deadZone = radius * DEAD_ZONE_RATIO;

    const baseRef = useRef<HTMLDivElement | null>(null);
    const pointerId = useRef<number | null>(null);
    const [knob, setKnob] = useState<{ x: number; y: number } | null>(null);

    const apply = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const base = baseRef.current;
        if (!base) return;
        const rect = base.getBoundingClientRect();
        const dx = event.clientX - (rect.left + rect.width / 2);
        const dy = event.clientY - (rect.top + rect.height / 2);
        // 손잡이는 원 안에 가둔다. 손가락이 밖으로 나가도 조작은 계속 먹어야 하므로 방향은 그대로 읽는다.
        const distance = Math.hypot(dx, dy);
        const clamp = distance > radius ? radius / distance : 1;
        setKnob({ x: dx * clamp, y: dy * clamp });
        setTouchDirection(directionFromOffset(dx, dy, deadZone));
    }, [deadZone, radius]);

    const release = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (pointerId.current !== event.pointerId) return;
        pointerId.current = null;
        setKnob(null);
        clearTouchDirection();
    }, []);

    const active = knob !== null;
    const infoInk = statusInkColors(theme).info;

    return (
        <div
            ref={baseRef}
            onPointerDown={(event) => {
                if (pointerId.current !== null) return;
                pointerId.current = event.pointerId;
                // 포인터를 붙잡아야 손가락이 원 밖으로 나가도 move가 계속 온다.
                event.currentTarget.setPointerCapture(event.pointerId);
                apply(event);
            }}
            onPointerMove={(event) => {
                if (pointerId.current !== event.pointerId) return;
                apply(event);
            }}
            onPointerUp={release}
            onPointerCancel={release}
            // 브라우저의 스크롤·확대 제스처가 먼저 가져가면 조이스틱이 중간에 끊긴다.
            style={{
                position: 'relative', width: size, height: size, borderRadius: '50%',
                touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
                background: `color-mix(in srgb, ${theme === 1 ? Color.black : Color.white} ${active ? 46 : 30}%, transparent)`,
                border: `3px solid ${active ? infoInk : Color.smoke[2]}`,
                backdropFilter: 'blur(2px)',
                transition: 'background-color 120ms ease-out, border-color 120ms ease-out',
            }}
            aria-label="이동 조이스틱"
        >
            <div style={{
                position: 'absolute', left: '50%', top: '50%',
                width: knobSize, height: knobSize, borderRadius: '50%',
                transform: `translate(-50%, -50%) translate(${knob?.x ?? 0}px, ${knob?.y ?? 0}px)`,
                background: theme === 1 ? Color.smoke[2] : Color.white,
                border: `3px solid ${active ? infoInk : Color.smoke[2]}`,
                boxShadow: active ? `0 0 0 3px color-mix(in srgb, ${infoInk} 32%, transparent)` : '0 2px 8px rgba(0,0,0,0.28)',
                pointerEvents: 'none',
                transition: active ? 'none' : 'transform 140ms ease-out, border-color 120ms ease-out',
            }} />
        </div>
    );
};
