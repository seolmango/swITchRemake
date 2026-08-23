/**
 * 게임 로직과 WebSocket 구현 사이의 경계.
 *
 * 방과 시뮬레이션은 이 인터페이스만 알고, `ws`나 `uWebSockets.js` 같은 구현은 모른다.
 * 첫 구현은 `ws`로 만들고, 부하 테스트에서 CPU·메모리·event loop lag가 문제가 될 때
 * 다른 구현을 추가할 수 있다. 그때 게임 로직은 한 줄도 바뀌지 않아야 한다.
 *
 * 이 파일은 B(전송·게이트웨이)와 D(방·대기실)가 만나는 지점이다. 양쪽이 함께 바꾼다.
 */

import type { ClientMessage, ServerMessage } from 'shared';

type ServerMessageBody = ServerMessage extends infer Message
    ? Message extends ServerMessage
        ? Omit<Message, 'v' | 'eventId' | 'serverTick'>
        : never
    : never;

/** 연결 하나의 핸들. 게임 로직이 소켓에 대해 아는 것은 이게 전부다. */
export interface Connection {
    readonly id: number;
    /** 티켓 검증으로 확정된 신원. 클라이언트가 보낸 값이 절대 아니다. */
    readonly userId: number | string;
    readonly nickname: string;
    readonly isGuest: boolean;
    readonly lobbyStats: { games: number; wins: number; switchSuccessRate: number } | null;
    readonly roomId: string;
    /** true면 D가 끊긴 slot/state를 복구하고, false면 새 참가를 확정한다. */
    readonly resume: boolean;
    /** 방 범위 slot. 방 안에서 사람을 가리키는 유일한 값이다. */
    readonly playerId: number;

    /** 저빈도 JSON 메시지. `eventId`와 `serverTick`은 전송 계층이 채운다. */
    sendJson(message: ServerMessageBody): void;
    /** 고빈도 바이너리 스냅샷. */
    sendBinary(payload: ArrayBuffer): void;

    /** 지금 소켓에 쌓여 있는 바이트. backpressure 판단에 쓴다. */
    bufferedBytes(): number;

    close(code: number, reason: string): void;
}

export interface TransportHandlers {
    /** 티켓 검증까지 끝난 연결. 이 콜백 이전에는 방이 연결의 존재를 모른다. */
    onConnect(connection: Connection): void;
    onInput(connection: Connection, frame: ArrayBuffer): void;
    /** 이미 스키마 검증을 통과한 메시지만 온다. */
    onJson(connection: Connection, message: ClientMessage): void;
    onDisconnect(connection: Connection, reason: string): void;
}

export interface GameTransport {
    listen(handlers: TransportHandlers): Promise<void>;
    /** draining 중에는 신규 연결을 받지 않는다. 기존 연결은 유지한다. */
    setAccepting(accepting: boolean): void;
    connectionCount(): number;
    close(): Promise<void>;
}
