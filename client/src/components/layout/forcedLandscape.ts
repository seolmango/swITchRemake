import { useSyncExternalStore, type CSSProperties } from 'react';

/**
 * 대기실부터 경기·결과까지는 폰을 세워 들어도 화면을 가로로 돌려 그린다.
 *
 * 브라우저가 화면 방향을 잠가 주면(전체 화면·설치한 앱의 Screen Orientation API) 그쪽을 먼저
 * 쓴다. 대부분의 모바일 브라우저 탭에서는 잠금이 거절되므로, 그때는 게임 영역을 CSS로 90° 돌린다.
 *
 * 돌린 화면 안에서는 세 가지를 같이 고쳐야 한다:
 *  1. 크기 — `window.innerWidth/innerHeight`는 여전히 세로라서, 돌린 상태면 둘을 바꿔 읽는다.
 *  2. 터치 방향 — 화면에서 손가락이 아래로 움직이면 돌린 화면 안에서는 오른쪽이다.
 *  3. 포털 — body에 붙이던 터치 조작은 같은 회전을 건 레이어에 붙여야 같이 돈다.
 */

let rotated = false;
const listeners = new Set<() => void>();

export const isRotated = (): boolean => rotated;

export function setRotated(next: boolean): void {
    if (next === rotated) return;
    rotated = next;
    if (!next) overlay?.remove();
    for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

export const useRotated = (): boolean => useSyncExternalStore(subscribe, isRotated, () => false);

/** 세로로 든 휴대폰인지. 태블릿·데스크톱 창을 세로로 줄인 경우는 돌리지 않는다. */
export function shouldForceLandscape(width: number, height: number): boolean {
    if (height <= width) return false;
    const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
    return Boolean(coarse) && width <= 900;
}

/** 시계 방향 90°. 위·왼쪽을 축으로 돌리고 오른쪽으로 화면 폭만큼 민다. */
export const ROTATED_STYLE: CSSProperties = {
    position: 'fixed',
    top: 0,
    left: '100vw',
    width: '100dvh',
    height: '100vw',
    transform: 'rotate(90deg)',
    transformOrigin: 'top left',
};

/** 화면 좌표의 이동량을 돌린 화면 안의 이동량으로. 화면 아래 = 안의 오른쪽, 화면 오른쪽 = 안의 위. */
export function toContentDelta(dx: number, dy: number): { x: number; y: number } {
    return rotated ? { x: dy, y: -dx } : { x: dx, y: dy };
}

/** 세로·가로를 돌린 화면 기준으로 읽는다. */
export function contentViewport(width: number, height: number): { width: number; height: number } {
    return rotated ? { width: height, height: width } : { width, height };
}

let overlay: HTMLElement | null = null;

/** 터치 조작을 붙일 자리. 돌린 상태면 같은 회전을 건 레이어, 아니면 body. */
export function overlayRoot(): HTMLElement {
    if (!rotated) return document.body;
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'forced-landscape-overlay';
        Object.assign(overlay.style, {
            ...ROTATED_STYLE,
            zIndex: '900',
            pointerEvents: 'none',
        } as Record<string, string>);
    }
    if (!overlay.isConnected) document.body.appendChild(overlay);
    return overlay;
}

/** 지원되는 곳에서는 실제로 방향을 잠근다. 실패는 정상이다 — 그때는 CSS 회전이 맡는다. */
export function tryLockLandscape(): void {
    const orientation = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
    void orientation?.lock?.('landscape').catch(() => undefined);
}
