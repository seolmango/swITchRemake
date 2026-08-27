import React, { useEffect, useRef, useState } from 'react';
import { Color } from '../../../theme/color.ts';
import { useSettingsStore, type TouchAnchor } from '../../../stores/useSettingsStore.ts';
import { TOUCH_BASE_SIZE, actionWheelReach, anchorFromPoint, placeAnchor } from './touchLayout.ts';
import { useViewportSize } from './useViewportSize.ts';

type Puck = 'move' | 'action';

interface Props {
    label: { move: string; action: string; hint: string };
}

/**
 * 조이스틱 배치 화면. 실제 화면 비율을 그대로 줄인 판 위에서 끌어다 놓는다.
 *
 * 슬라이더 두 쌍(가로/세로 × 조이스틱 둘)으로 만들지 않은 이유는, 위치를 정할 때 사람이 보는
 * 것이 숫자가 아니라 **손이 닿는 자리**이기 때문이다. 화면 비율이 기기마다 다르므로 판도 지금
 * 화면의 비율을 따라간다.
 *
 * 가두는 규칙(`placeAnchor`)을 인게임과 같이 쓴다. 다르면 "설정에서 둔 자리와 실제 자리가
 * 다르다"가 되고, 사용자는 자기가 뭘 잘못했는지 알 수 없다.
 */
export const TouchLayoutEditor: React.FC<Props> = ({ label }) => {
    const scale = useSettingsStore((state) => state.touchScale);
    const moveAnchor = useSettingsStore((state) => state.touchMoveAnchor);
    const actionAnchor = useSettingsStore((state) => state.touchActionAnchor);
    const setGameSetting = useSettingsStore((state) => state.setGameSetting);
    const viewport = useViewportSize();

    const boardRef = useRef<HTMLDivElement | null>(null);
    const dragging = useRef<Puck | null>(null);
    const [active, setActive] = useState<Puck | null>(null);
    // 손잡이 자리를 렌더 중에 계산해야 하는데, ref는 첫 렌더에 비어 있다. 측정값을 state로 든다.
    const [board, setBoard] = useState({ width: 0, height: 0 });

    useEffect(() => {
        const element = boardRef.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => {
            if (entry) setBoard({ width: entry.contentRect.width, height: entry.contentRect.height });
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const aspect = viewport.height > 0 ? viewport.width / viewport.height : 16 / 9;

    const drag = (event: React.PointerEvent<HTMLDivElement>) => {
        const board = boardRef.current;
        const puck = dragging.current;
        if (!board || puck === null) return;
        const rect = board.getBoundingClientRect();
        const anchor = anchorFromPoint(
            { x: event.clientX - rect.left, y: event.clientY - rect.top },
            { width: rect.width, height: rect.height },
        );
        setGameSetting(puck === 'move' ? 'touchMoveAnchor' : 'touchActionAnchor', anchor);
    };

    const stop = () => { dragging.current = null; setActive(null); };

    return (
        <div style={{ display: 'grid', gap: 12, justifyItems: 'stretch', width: '100%' }}>
            <div
                ref={boardRef}
                onPointerMove={drag}
                onPointerUp={stop}
                onPointerLeave={stop}
                onPointerCancel={stop}
                style={{
                    position: 'relative', width: '100%', aspectRatio: String(aspect),
                    borderRadius: 18, overflow: 'hidden', touchAction: 'none',
                    background: 'var(--settings-preview-bg, rgba(120,120,120,0.16))',
                    border: `3px solid ${Color.gray[1]}`,
                }}
            >
                <Handle
                    board={board}
                    viewportWidth={viewport.width}
                    anchor={moveAnchor}
                    scale={scale}
                    reachRatio={0.5}
                    label={label.move}
                    active={active === 'move'}
                    onGrab={(event) => { dragging.current = 'move'; setActive('move'); drag(event); }}
                />
                <Handle
                    board={board}
                    viewportWidth={viewport.width}
                    anchor={actionAnchor}
                    scale={scale}
                    reachRatio={actionWheelReach(1)}
                    label={label.action}
                    active={active === 'action'}
                    onGrab={(event) => { dragging.current = 'action'; setActive('action'); drag(event); }}
                />
            </div>
            <small style={{ opacity: 0.75 }}>{label.hint}</small>
        </div>
    );
};

/**
 * 판 위의 손잡이 하나.
 *
 * 크기를 판 기준으로 다시 계산한다 — 판은 실제 화면을 줄인 것이므로, 같은 비율로 줄여야
 * "이만큼 자리를 차지한다"가 눈에 맞는다. 액션 쪽은 선택기가 열리는 반경까지 그린다.
 */
const Handle: React.FC<{
    board: { width: number; height: number };
    /** 진짜 화면 폭. 판이 그 몇 분의 1인지로 조이스틱 크기를 줄인다. */
    viewportWidth: number;
    anchor: TouchAnchor;
    scale: number;
    /** 조이스틱 지름 대비 차지 반경. 이동은 0.5(자기 원), 액션은 선택기까지. */
    reachRatio: number;
    label: string;
    active: boolean;
    onGrab: (event: React.PointerEvent<HTMLDivElement>) => void;
}> = ({ board, viewportWidth, anchor, scale, reachRatio, label, active, onGrab }) => {
    // 판이 실제 화면의 몇 분의 1인지. 조이스틱도 같은 비율로 줄여야 크기 감각이 맞는다.
    const shrink = viewportWidth > 0 ? board.width / viewportWidth : 0;
    const size = TOUCH_BASE_SIZE * scale * shrink;
    const reach = size * reachRatio;
    const place = placeAnchor(anchor, board, reach);

    return (
        <div
            onPointerDown={(event) => { event.preventDefault(); onGrab(event); }}
            style={{
                position: 'absolute', left: place.x, top: place.y,
                transform: 'translate(-50%, -50%)',
                width: Math.max(28, size), height: Math.max(28, size), borderRadius: '50%',
                display: 'grid', placeItems: 'center', cursor: 'grab', touchAction: 'none',
                background: active ? Color.blue[2] : `color-mix(in srgb, ${Color.blue[2]} 34%, transparent)`,
                border: `3px solid ${Color.blue[2]}`,
                // 선택기까지 포함한 자리를 옅게 그린다. 서로 겹치는지 여기서 보인다.
                boxShadow: reach > size / 2
                    ? `0 0 0 ${Math.max(0, reach - size / 2)}px color-mix(in srgb, ${Color.blue[2]} 12%, transparent)`
                    : 'none',
                color: Color.white, fontWeight: 800, fontSize: Math.max(10, size * 0.22),
                userSelect: 'none', WebkitUserSelect: 'none',
            }}
        >
            {label}
        </div>
    );
};
