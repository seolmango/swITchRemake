import type { TouchAnchor } from '../../../stores/useSettingsStore.ts';

/**
 * 터치 조작이 쓰는 쌓임 순서.
 *
 * 겹판과 선택기는 `document.body`로 따로 포털되므로 **서로 형제가 아니다.** z-index를 안 주면
 * `z-index: auto`가 되는데, 그러면 게임 무대(`GameContainer`, z-index 1)보다 뒤에 그려진다.
 * 좌표는 맞는데 화면에는 안 보이는 상태가 되고, 눌러도 아무 일도 안 일어나는 것처럼 보인다.
 */
export const TOUCH_Z = { controls: 60, wheel: 70 } as const;

/** 기본 조이스틱 지름(px). 설정의 배율이 여기에 곱해진다. */
export const TOUCH_BASE_SIZE = 132;

/**
 * 액션 조이스틱이 화면 가장자리에서 떨어져야 하는 거리 — 자기 반지름뿐이다.
 *
 * 선택기는 조이스틱 둘레가 아니라 **화면 한가운데**에 뜨므로(`ActionWheel`) 조이스틱 옆에
 * 자리를 비워 둘 필요가 없다. 예전에는 선택기 반경까지 비워 두느라 조이스틱이 화면 안쪽으로
 * 한참 밀려나 엄지가 닿지 않았다.
 */
export const actionWheelReach = (size: number): number => size / 2;

export interface Placement {
    /** 화면 좌표(px). 조이스틱의 **중심**이다. */
    x: number;
    y: number;
}

/**
 * 정규화된 위치를 화면 좌표로 옮기면서, 컨트롤 전체가 화면 안에 들어오도록 가둔다.
 *
 * 가두는 쪽을 택한 이유: 선택기가 화면 밖으로 나가면 보이지 않는 칸이 생기는데, 선택기를 따로
 * 밀어 넣으면 손가락이 미는 방향과 칸의 위치가 어긋난다. 방향과 그림이 어긋나느니 조이스틱이
 * 조금 안쪽에 있는 편이 낫다. 설정의 배치 화면도 같은 함수를 쓴다 — 다르면 "설정에서 둔 자리와
 * 실제 자리가 다르다"가 된다.
 */
export function placeAnchor(anchor: TouchAnchor, viewport: { width: number; height: number }, reach: number): Placement {
    const clamp = (value: number, span: number) => {
        // 컨트롤이 화면보다 크면 가운데가 최선이다.
        if (reach * 2 > span) return span / 2;
        return Math.min(Math.max(value * span, reach), span - reach);
    };
    return { x: clamp(anchor.x, viewport.width), y: clamp(anchor.y, viewport.height) };
}

/** 화면 좌표를 정규화된 위치로 되돌린다. 배치 화면에서 끌어다 놓을 때 쓴다. */
export function anchorFromPoint(point: Placement, viewport: { width: number; height: number }): TouchAnchor {
    const ratio = (value: number, span: number) => (span <= 0 ? 0.5 : Math.min(1, Math.max(0, value / span)));
    return { x: ratio(point.x, viewport.width), y: ratio(point.y, viewport.height) };
}
