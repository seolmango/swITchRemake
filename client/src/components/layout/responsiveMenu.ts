/**
 * 세로 폰에서 일반 문서 흐름을 쓸 화면인지. 쓰지 않는 쪽이 예외다 — 플레이 가능한 캔버스는
 * 16:9 스테이지를 통째로 축소해야 좌표가 맞고, 흐름에 풀면 조작 자리가 어긋난다.
 *
 * 허용 목록이 아니라 거부 목록인 이유: 메뉴 화면은 계속 늘어나고, 목록에서 빠진 화면은
 * 조용히 축소돼 폰에서 글자와 버튼이 20px짜리로 줄어든다. 실제로 404 화면이 그랬다.
 * 새 화면의 기본값은 "읽을 수 있다"여야 하고, 캔버스를 들이는 화면만 여기에 적는다.
 */
const CANVAS_ROUTES = ['/game', '/training'];

export function supportsPortraitMenu(pathname: string): boolean {
    return !CANVAS_ROUTES.includes(pathname);
}
