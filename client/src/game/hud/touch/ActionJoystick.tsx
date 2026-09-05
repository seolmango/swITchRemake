import React, { useCallback, useRef, useState } from 'react';
import type { Theme } from '../../types.ts';
import type { HudPlayer } from '../hudTypes.ts';
import { Color, statusInkColors } from '../../../theme/color.ts';
import type { ColorVisionMode } from '../../../theme/cvd.ts';
import { slotFromOffset } from '../../touchInput.ts';
import { HUD_FONT } from '../hudTheme.ts';
import { ActionWheel, WHEEL_SLOTS } from './ActionWheel.tsx';
import type { ActionMode } from './actionMode.ts';

interface Props {
    theme: Theme;
    colorVision: ColorVisionMode;
    size: number;
    mode: ActionMode;
    players: readonly HudPlayer[];
    onPick: (mode: ActionMode, slot: number) => void;
}

/** 가운데로 되돌리면 취소. 열었다가 마음이 바뀌는 일이 자주 있다. */
const DEAD_ZONE_RATIO = 0.3;

/**
 * 오른손 액션 조이스틱. 누르면 선택기가 열리고, 밀었다 떼면 그 칸이 나간다.
 *
 * 선택기는 **화면 한가운데**에 뜬다(`ActionWheel`). 방향은 여기, 조이스틱 중심에서 잰다 —
 * 손가락이 있는 곳이 여기이기 때문이다.
 *
 * 칸은 **1~8 고정**이다. 지금 지목 가능한 대상만 배치하면 후보가 들고 날 때마다 자리가 통째로
 * 재배치돼서 손이 기억한 방향이 매번 달라진다. 유효하지 않은 번호를 고를 수 있는 것은 키보드도
 * 마찬가지다 — 아무 때나 잘못된 숫자를 누를 수 있다.
 */
export const ActionJoystick: React.FC<Props> = ({ theme, colorVision, size, mode, players, onPick }) => {
    const baseRef = useRef<HTMLDivElement | null>(null);
    const pointerId = useRef<number | null>(null);
    const [open, setOpen] = useState(false);
    const [hover, setHover] = useState<number | null>(null);
    const infoInk = statusInkColors(theme).info;

    const track = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const base = baseRef.current;
        if (!base) return;
        const rect = base.getBoundingClientRect();
        const dx = event.clientX - (rect.left + rect.width / 2);
        const dy = event.clientY - (rect.top + rect.height / 2);
        setHover(slotFromOffset(dx, dy, (size / 2) * DEAD_ZONE_RATIO, WHEEL_SLOTS));
    }, [size]);

    const finish = useCallback((event: React.PointerEvent<HTMLDivElement>, fire: boolean) => {
        if (pointerId.current !== event.pointerId) return;
        pointerId.current = null;
        setOpen(false);
        const picked = hover;
        setHover(null);
        if (fire && picked !== null) onPick(mode, picked);
    }, [hover, mode, onPick]);

    return (
        <>
            {open && (
                <ActionWheel theme={theme} colorVision={colorVision} mode={mode} players={players} hover={hover} />
            )}
            <div
                ref={baseRef}
                onPointerDown={(event) => {
                    if (pointerId.current !== null) return;
                    pointerId.current = event.pointerId;
                    // 포인터를 붙잡아야 손가락이 조이스틱 밖으로 나가도 move가 계속 온다.
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setOpen(true);
                    setHover(null);
                }}
                onPointerMove={(event) => {
                    if (pointerId.current !== event.pointerId) return;
                    track(event);
                }}
                onPointerUp={(event) => finish(event, true)}
                // 시스템이 제스처를 가져갔다. 의도하지 않은 발사가 되면 안 되므로 취소로 친다.
                onPointerCancel={(event) => finish(event, false)}
                style={{
                    position: 'relative', width: size, height: size, borderRadius: '50%',
                    touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
                    display: 'grid', placeItems: 'center',
                    background: `color-mix(in srgb, ${theme === 1 ? Color.black : Color.white} ${open ? 52 : 32}%, transparent)`,
                    border: `3px solid ${open ? infoInk : Color.smoke[2]}`,
                    backdropFilter: 'blur(2px)',
                    fontFamily: HUD_FONT, fontWeight: 800, fontSize: size * 0.2,
                    color: theme === 1 ? Color.white : Color.black,
                }}
                aria-label={mode === 'switch' ? '스위치 조이스틱' : '이모지 조이스틱'}
            >
                {mode === 'switch' ? 'SW' : '☺'}
            </div>
        </>
    );
};
