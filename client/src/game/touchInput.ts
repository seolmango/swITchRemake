/**
 * 터치 조이스틱이 만든 이동 방향을 키보드 입력 루프에 넘기는 통로.
 *
 * React state를 쓰지 않는 이유는 읽는 쪽이 30Hz 타이머이기 때문이다. 손가락이 움직일 때마다
 * 리렌더가 나면 화면 전체가 초당 수십 번 다시 그려지는데, 정작 그 값이 필요한 곳은 렌더 트리가
 * 아니라 `setInterval` 안이다.
 *
 * 키보드를 대체하지 않고 **합쳐진다**(GamePage에서 OR). 태블릿에 키보드를 붙인 사람이 둘 다
 * 쓸 수 있어야 하고, 한쪽이 다른 쪽을 끄면 그 조합에서 조작이 죽는다.
 */

export interface TouchDirection {
    left: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
}

const NEUTRAL: TouchDirection = { left: false, right: false, up: false, down: false };

let current: TouchDirection = NEUTRAL;

export function setTouchDirection(direction: TouchDirection): void {
    current = direction;
}

export function clearTouchDirection(): void {
    current = NEUTRAL;
}

export function readTouchDirection(): TouchDirection {
    return current;
}

/**
 * 조이스틱 오프셋을 8방향 입력으로 바꾼다.
 *
 * 아날로그로 만들지 않는 이유는 와이어 계약이 상하좌우 4비트이기 때문이다(`shared`의 `InputState`).
 * 기울기를 실으려면 프로토콜 버전과 서버 이동 계산, 리플레이 포맷이 같이 바뀌어야 하는데,
 * 이 게임은 이동 속도가 상태(광란·탈진)로만 정해지므로 "살짝 기울여 천천히"가 애초에 없다.
 *
 * @param dx 조이스틱 중심에서의 가로 변위(px). 오른쪽이 양수.
 * @param dy 세로 변위(px). **화면 좌표라 아래가 양수다.**
 * @param deadZonePx 이 안에서는 중립. 손가락을 얹어 두기만 한 상태가 이동이 되면 안 된다.
 */
export function directionFromOffset(dx: number, dy: number, deadZonePx: number): TouchDirection {
    const distance = Math.hypot(dx, dy);
    if (distance < deadZonePx) return NEUTRAL;

    // 0 = 오른쪽, 시계방향으로 45도씩. atan2는 아래가 양수인 화면 좌표를 그대로 받는다.
    const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) & 7;
    return {
        right: sector === 0 || sector === 1 || sector === 7,
        down: sector === 1 || sector === 2 || sector === 3,
        left: sector === 3 || sector === 4 || sector === 5,
        up: sector === 5 || sector === 6 || sector === 7,
    };
}

/**
 * 방사형 선택기에서 지금 가리키는 칸. 중립이면 null이다(놓아도 아무것도 안 나간다).
 *
 * 칸 1이 12시이고 시계방향으로 늘어난다 — 이모지 휠(`EmojiWheel`)과 같은 배치다. 같은 손동작이
 * 화면에 따라 다른 것을 고르면 안 된다.
 */
export function slotFromOffset(dx: number, dy: number, deadZonePx: number, slots: number): number | null {
    if (Math.hypot(dx, dy) < deadZonePx) return null;
    // 12시를 0으로 돌린다.
    const angle = Math.atan2(dy, dx) + Math.PI / 2;
    const turns = angle / (Math.PI * 2);
    const index = Math.round(turns * slots);
    return ((index % slots) + slots) % slots + 1;
}
