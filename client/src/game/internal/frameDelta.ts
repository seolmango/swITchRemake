/**
 * 숨겨진 탭의 rAF가 다시 시작할 때 수 초짜리 delta가 한 프레임에 들어올 수 있다.
 * 서버의 최신 상태를 그리는 렌더러이므로 그 시간을 따라잡지 않고 한 프레임 분량만 반영한다.
 */
export const MAX_FRAME_DELTA_MS = 50;

export function boundFrameDelta(deltaMs: number): number {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 0;
    return Math.min(deltaMs, MAX_FRAME_DELTA_MS);
}
