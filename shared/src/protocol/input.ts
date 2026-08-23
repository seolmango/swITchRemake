/**
 * 클라이언트 -> 서버 입력 패킷.
 *
 * 서버는 여기서 온 값을 "의도"로만 받는다. 좌표, 속도, 이동 거리, 쿨타임은 클라이언트가 보낼 수단이
 * 아예 없어야 하며, 실제로 이 패킷에는 그런 필드가 없다.
 */

import { PROTOCOL_VERSION } from './constants';

export const MessageType = {
    InputState: 0x01,
} as const;

/** u8 version + u8 type + u16 sequence + u8 movement + u8 heldActions. */
export const INPUT_PACKET_BYTES = 6;

export const MovementBits = {
    Left: 0x01,
    Right: 0x02,
    Up: 0x04,
    Down: 0x08,
} as const;

export interface InputState {
    sequence: number;
    left: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
    /** 누르고 있는 동안 유지되는 행동 비트. 의미는 gameplay 설정이 정한다. */
    heldActions: number;
}

export class InputDecodeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InputDecodeError';
    }
}

export function encodeInput(state: InputState): ArrayBuffer {
    const buf = new ArrayBuffer(INPUT_PACKET_BYTES);
    const view = new DataView(buf);
    let movement = 0;
    if (state.left) movement |= MovementBits.Left;
    if (state.right) movement |= MovementBits.Right;
    if (state.up) movement |= MovementBits.Up;
    if (state.down) movement |= MovementBits.Down;

    view.setUint8(0, PROTOCOL_VERSION);
    view.setUint8(1, MessageType.InputState);
    view.setUint16(2, state.sequence & 0xffff, true);
    view.setUint8(4, movement);
    view.setUint8(5, state.heldActions & 0xff);
    return buf;
}

/**
 * 길이가 정확히 일치할 때만 처리한다. 모자라도 남아도 패킷 전체를 버린다.
 * 남는 바이트를 관대하게 무시하면 그게 곧 파서 공격면이 된다.
 */
export function decodeInput(buffer: ArrayBuffer): InputState {
    if (buffer.byteLength !== INPUT_PACKET_BYTES) {
        throw new InputDecodeError(`input packet must be exactly ${INPUT_PACKET_BYTES} bytes, got ${buffer.byteLength}`);
    }
    const view = new DataView(buffer);
    const version = view.getUint8(0);
    if (version !== PROTOCOL_VERSION) {
        throw new InputDecodeError(`protocol version mismatch: got ${version}, expected ${PROTOCOL_VERSION}`);
    }
    const type = view.getUint8(1);
    if (type !== MessageType.InputState) {
        throw new InputDecodeError(`unknown message type 0x${type.toString(16)}`);
    }

    const movement = view.getUint8(4);
    return {
        sequence: view.getUint16(2, true),
        left: (movement & MovementBits.Left) !== 0,
        right: (movement & MovementBits.Right) !== 0,
        up: (movement & MovementBits.Up) !== 0,
        down: (movement & MovementBits.Down) !== 0,
        heldActions: view.getUint8(5),
    };
}

/**
 * 좌우 또는 상하가 동시에 눌리면 그 축을 0으로 만들고, 대각선은 정규화한다.
 * 서버와 클라이언트 예측이 같은 결과를 내야 하므로 이 계산은 한 곳에만 있어야 한다.
 */
export function movementVector(state: InputState): { x: number; y: number } {
    let x = (state.right ? 1 : 0) - (state.left ? 1 : 0);
    let y = (state.down ? 1 : 0) - (state.up ? 1 : 0);
    if (x !== 0 && y !== 0) {
        const inv = Math.SQRT1_2;
        x *= inv;
        y *= inv;
    }
    return { x, y };
}

/**
 * u16 sequence는 60Hz에서 약 18분마다 한 바퀴 돈다.
 * `a > b` 같은 단순 비교로 "과거 입력 무시"를 구현하면 wrap 시점 이후 모든 입력이 무시된다.
 * 부호 있는 16비트 차이로 비교해 wrap을 넘긴다.
 *
 * @returns a가 b보다 나중이면 양수, 이전이면 음수, 같으면 0.
 */
export function compareSequence(a: number, b: number): number {
    return (((a - b) & 0xffff) << 16) >> 16;
}

/** a가 b보다 나중인가. 같은 값은 나중이 아니다(중복 입력은 버린다). */
export function isNewerSequence(a: number, b: number): boolean {
    return compareSequence(a, b) > 0;
}

export function nextSequence(current: number): number {
    return (current + 1) & 0xffff;
}
