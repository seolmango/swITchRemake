import React from 'react';
import { createPortal } from 'react-dom';
import type { Theme } from '../../types.ts';
import type { HudPlayer } from '../hudTypes.ts';
import { Color, statusInkColors } from '../../../theme/color.ts';
import type { ColorVisionMode } from '../../../theme/cvd.ts';
import { emojiDataUri } from '../../emoji.ts';
import { HUD_FONT, HUD_METRICS, mutedText, userColors } from '../hudTheme.ts';
import { TOUCH_Z } from './touchLayout.ts';
import type { ActionMode } from './actionMode.ts';
import { useViewportSize } from './useViewportSize.ts';

export const WHEEL_SLOTS = 8;

interface Props {
    theme: Theme;
    colorVision: ColorVisionMode;
    mode: ActionMode;
    players: readonly HudPlayer[];
    /** 지금 가리키는 칸(1..8). 손가락이 중립이면 null이고, 그대로 떼면 아무것도 안 나간다. */
    hover: number | null;
}

/**
 * 스위치·이모지 선택기. **화면 한가운데**에 뜬다.
 *
 * 조이스틱 둘레에 그리지 않는 이유는 두 가지다. 하나는 손가락이 그림을 가린다는 것 — 고르는
 * 자리를 자기 엄지로 덮는다. 다른 하나는 키보드 쪽과 같은 그림이어야 한다는 것이다. Shift를
 * 누르면 뜨는 이모지 휠도 화면 중앙이라, 같은 게임에서 같은 선택을 두 가지 그림으로 배우게
 * 할 이유가 없다.
 *
 * 방향은 여전히 **조이스틱 중심 기준**으로 잰다. 손가락이 있는 곳이 거기이기 때문이다.
 * 그림의 위치와 판정의 기준이 달라도 되는 이유는, 사람이 읽는 것이 각도이지 좌표가 아니라서다.
 */
export const ActionWheel: React.FC<Props> = ({ theme, colorVision, mode, players, hover }) => {
    const viewport = useViewportSize();
    // 가로로 누운 폰은 높이가 모자란다. 짧은 변을 기준으로 잡아야 위아래 칸이 잘리지 않는다.
    const shortSide = Math.min(viewport.width, viewport.height);
    const radius = Math.max(74, Math.min(150, shortSide * 0.3));
    const slot = radius * 0.46;
    const iconColor = theme === 1 ? Color.white : Color.black;
    const infoInk = statusInkColors(theme).info;

    /*
     * `document.body`로 한 번 더 포털한다. 조이스틱을 화면 구석에 놓는 감싸개가
     * `transform: translate(-50%, -50%)`를 쓰는데, transform이 걸린 조상은 `position: fixed`의
     * 기준이 되어 버린다. 그대로 두면 "화면 한가운데"가 **조이스틱 한가운데**가 된다.
     */
    return createPortal(
        <div style={{
            position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
            zIndex: TOUCH_Z.wheel, pointerEvents: 'none', fontFamily: HUD_FONT,
            background: `color-mix(in srgb, ${Color.black} ${theme === 1 ? 45 : 28}%, transparent)`,
            backdropFilter: 'blur(2px)',
        }}>
            <div style={{ position: 'relative', width: radius * 2 + slot, height: radius * 2 + slot }}>
                {Array.from({ length: WHEEL_SLOTS }, (_, index) => {
                    const id = index + 1;
                    // 1번이 12시, 시계방향. `slotFromOffset`과 EmojiWheel이 모두 이 배치다.
                    const angle = (index / WHEEL_SLOTS) * Math.PI * 2 - Math.PI / 2;
                    const focused = hover === id;
                    const player = players.find((candidate) => candidate.id === id) ?? null;
                    const uri = mode === 'emoji' ? emojiDataUri(id, iconColor, 96) : null;
                    // 스위치 칸은 그 번호의 플레이어 색을 두른다. 월드에서 보이는 색과 같아야
                    // 이름을 읽지 않고도 고를 수 있다.
                    const tint = mode === 'switch' && player
                        ? userColors(player.colorIndex, colorVision)[0]
                        : (theme === 1 ? Color.smoke[2] : Color.gray[1]);

                    return (
                        <div
                            key={id}
                            style={{
                                position: 'absolute', left: '50%', top: '50%',
                                width: slot, height: slot, borderRadius: '50%',
                                transform: `translate(-50%, -50%) translate(${Math.cos(angle) * radius}px, ${Math.sin(angle) * radius}px) scale(${focused ? 1.16 : 1})`,
                                display: 'grid', placeItems: 'center',
                                background: theme === 1 ? Color.black : Color.white,
                                border: `4px solid ${focused ? infoInk : tint}`,
                                boxShadow: focused ? `0 0 0 5px color-mix(in srgb, ${infoInk} 34%, transparent)` : 'none',
                                opacity: focused ? 1 : 0.82,
                                transition: 'transform 90ms ease-out, border-color 90ms ease-out, opacity 90ms ease-out',
                            }}
                        >
                            {uri
                                ? <img src={uri} alt="" style={{ width: slot * 0.6, height: slot * 0.6 }} />
                                : <span style={{
                                    fontSize: slot * 0.46, fontWeight: 800,
                                    color: theme === 1 ? Color.white : Color.black,
                                }}>{id}</span>}
                        </div>
                    );
                })}

                <div style={{
                    position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
                    textAlign: 'center', color: mutedText(theme),
                    fontSize: HUD_METRICS.captionFont, fontWeight: 700, lineHeight: 1.6,
                }}>
                    {mode === 'switch' ? '스위치' : '이모지'}<br />
                    <span style={{ opacity: 0.8 }}>밀어서 고르고 떼기</span>
                </div>
            </div>
        </div>,
        document.body,
    );
};
