/**
 * 저빈도 JSON 메시지 카탈로그. docs/SERVER_ARCHITECTURE.md의 "JSON 메시지 카탈로그" 절이 원본이다.
 *
 * 규칙:
 *  - 모든 메시지는 `v`와 `type`을 갖는다. `type`은 `명사.동사` 형태다.
 *  - 클라이언트 요청은 연결 안에서만 유효한 증가 정수 `requestId`를 갖고, 서버는 거부할 때 되돌려준다.
 *  - 서버 이벤트는 연결 안에서 단조 증가하는 `eventId`와 그 시점의 `serverTick`을 갖는다.
 *  - 서버는 성공 응답을 따로 보내지 않는다. 성공은 뒤따르는 상태 이벤트나 스냅샷으로 확인한다.
 *  - 서버는 `userId`를 클라이언트에 내려보내지 않는다. 방 안에서 사람을 가리키는 값은 항상 `playerId`다.
 */

import type { SkillId, SkillRejection } from './skills';

export const JSON_MESSAGE_VERSION = 1;

/* ────────────────────────────── 공통 ────────────────────────────── */

export const RoomState = {
    Allocating: 'ALLOCATING',
    Waiting: 'WAITING',
    Countdown: 'COUNTDOWN',
    Playing: 'PLAYING',
    PostGame: 'POST_GAME',
    Closed: 'CLOSED',
} as const;
export type RoomState = (typeof RoomState)[keyof typeof RoomState];

export const PlayerRole = {
    /** 이번 경기의 참가자. */
    Player: 'player',
    /** 대기실에 있고 이번 경기에는 참가하지 않는다. 스냅샷을 받지 않는다. */
    Waiting: 'waiting',
    /** 비검열 스냅샷을 받는다. 입력과 스킬 요청은 무시된다. */
    Spectator: 'spectator',
} as const;
export type PlayerRole = (typeof PlayerRole)[keyof typeof PlayerRole];

/**
 * `error` 메시지의 코드 집합. 클라이언트는 모르는 코드를 만나면 일반 오류 문구로 표시한다.
 */
export const ErrorCode = {
    /** 티켓 무효, 만료, 재사용, 서버 불일치를 모두 포함한다. 사유를 구분해 주지 않는다. */
    AuthFailed: 'AUTH_FAILED',
    AuthTimeout: 'AUTH_TIMEOUT',
    ProtocolMismatch: 'PROTOCOL_MISMATCH',
    NotHost: 'NOT_HOST',
    BadState: 'BAD_STATE',
    InvalidPayload: 'INVALID_PAYLOAD',
    RateLimited: 'RATE_LIMITED',
    RoomClosed: 'ROOM_CLOSED',
    Kicked: 'KICKED',
    SpectateDenied: 'SPECTATE_DENIED',
    StartLocked: 'START_LOCKED',
    ServerShutdown: 'SERVER_SHUTDOWN',
    Internal: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * 재시도로 해결되지 않는 코드. 클라이언트가 자동 재접속 루프를 돌면 안 된다.
 * 서버는 `error`의 `retryable`을 이 집합으로 채운다.
 */
export const NON_RETRYABLE_ERRORS: readonly ErrorCode[] = [
    ErrorCode.AuthFailed,
    ErrorCode.AuthTimeout,
    ErrorCode.ProtocolMismatch,
    ErrorCode.Kicked,
    ErrorCode.RoomClosed,
];

export function isRetryable(code: ErrorCode): boolean {
    return !NON_RETRYABLE_ERRORS.includes(code);
}

/**
 * WebSocket close code. 사유는 종료 직전 `error` 메시지로 먼저 보낸다.
 * 브라우저에서 close reason 문자열을 신뢰하기 어렵기 때문이다.
 */
export const CloseCode = {
    Normal: 1000,
    PolicyViolation: 1008,
    MessageTooBig: 1009,
} as const;

/* ────────────────────────── 클라이언트 -> 서버 ────────────────────────── */

interface ClientEnvelope<T extends string, P> {
    v: typeof JSON_MESSAGE_VERSION;
    type: T;
    /** 연결 안에서만 유효한 증가 정수. 거부 응답이 이 값을 되돌려준다. */
    requestId?: number;
    payload: P;
}

/** 접속 후 제한 시간(기본 5초) 안에 보내야 한다. 이 메시지 이전에는 아무것도 파싱하지 않는다. */
export type AuthMessage = ClientEnvelope<'auth', { ticket: string }>;
export type LobbySetMapMessage = ClientEnvelope<'lobby.setMap', { mapId: string }>;
export type LobbyKickMessage = ClientEnvelope<'lobby.kick', { playerId: number }>;
export type LobbyPassHostMessage = ClientEnvelope<'lobby.passHost', { playerId: number }>;
export type LobbySetLockedMessage = ClientEnvelope<'lobby.setLocked', { locked: boolean }>;
export type LobbyStartMessage = ClientEnvelope<'lobby.start', Record<string, never>>;
export type LobbyLeaveMessage = ClientEnvelope<'lobby.leave', Record<string, never>>;
export type LobbySetLoadoutMessage = ClientEnvelope<'lobby.setLoadout', { skills: string[] }>;
export type LobbySpectateMessage = ClientEnvelope<'lobby.spectate', { spectate: boolean }>;
/**
 * 슬롯 1은 스위치(러너 전용), 슬롯 2는 경기 전에 고른 스킬이다.
 * `targetPlayerId`는 스위치에만 쓴다 — 지목 대상은 맵 어디에 있어도 되므로 서버가 좌표로 추론할 수 없다.
 */
export type GameUseSkillMessage = ClientEnvelope<'game.useSkill', { slot: number; targetPlayerId?: number }>;
export type GameEmojiMessage = ClientEnvelope<'game.emoji', { emojiId: number }>;
export type PingMessage = ClientEnvelope<'ping', { clientTime: number }>;

export type ClientMessage =
    | AuthMessage
    | LobbySetMapMessage
    | LobbyKickMessage
    | LobbyPassHostMessage
    | LobbySetLockedMessage
    | LobbyStartMessage
    | LobbyLeaveMessage
    | LobbySetLoadoutMessage
    | LobbySpectateMessage
    | GameUseSkillMessage
    | GameEmojiMessage
    | PingMessage;

export type ClientMessageType = ClientMessage['type'];

/* ────────────────────────── 서버 -> 클라이언트 ────────────────────────── */

interface ServerEnvelope<T extends string, P> {
    v: typeof JSON_MESSAGE_VERSION;
    type: T;
    /** 연결 안에서 단조 증가. */
    eventId: number;
    serverTick: number;
    payload: P;
}

export interface LobbyPlayer {
    playerId: number;
    nickname: string;
    colorIndex: number;
    guest: boolean;
    role: PlayerRole;
    /**
     * 이 사람이 고른 로드아웃. `lobby.setLoadout`으로 보낸 것이 그대로 돌아온다 — 보내는 형태와 보이는
     * 형태가 같아야 클라이언트가 두 벌의 변환을 갖지 않는다.
     *
     * 지금은 2번 슬롯 하나뿐이라 길이 1이다. 슬롯이 늘면 뒤에 붙는다. 1번 슬롯(스위치)은 고를 수 있는
     * 대상이 아니라서 여기 없다.
     */
    skills: SkillId[];
}

export type AuthOkMessage = ServerEnvelope<'auth.ok', {
    playerId: number;
    roomId: string;
    roomState: RoomState;
    role: PlayerRole;
    guest: boolean;
    protocolVersion: number;
    rulesVersion: string;
    mapBundleHash: string;
}>;

export type LobbyStateMessage = ServerEnvelope<'lobby.state', {
    hostId: number;
    mapId: string;
    capacity: number;
    locked: boolean;
    /** 시작 버튼이 풀리기까지 남은 밀리초. 0이면 시작할 수 있다. */
    startLockMs: number;
    players: LobbyPlayer[];
}>;

export type LobbyHostChangedMessage = ServerEnvelope<'lobby.hostChanged', { hostId: number }>;

export type GameStartingMessage = ServerEnvelope<'game.starting', {
    startsAtTick: number;
    countdownMs: number;
    mapId: string;
    /** HUD가 필요한 쿨타임과 지속시간. 클라이언트에 같은 상수를 복사하지 않기 위한 통로다. */
    gameplay: Record<string, number>;
}>;

export type GameStartedMessage = ServerEnvelope<'game.started', { startTick: number; taggerId: number }>;
/**
 * 스킬 요청이 거부됐다. **요청한 본인에게만** 간다.
 *
 * 거부돼도 쿨타임은 소모되므로(`SkillRejection` 주석) 이유를 안 보여주면 사용자는 그냥 "안 눌렸다"고
 * 읽는다. 성공은 따로 알리지 않는다 — 뒤따르는 스냅샷과 `player.tagged`가 곧 성공의 증거다.
 */
export type SkillRejectedMessage = ServerEnvelope<'skill.rejected', {
    slot: number;
    reason: SkillRejection;
}>;

export type PlayerTaggedMessage = ServerEnvelope<'player.tagged', { playerId: number; by: number }>;
export type PlayerEliminatedMessage = ServerEnvelope<'player.eliminated', { playerId: number; by: number }>;
export type PlayerLeftMessage = ServerEnvelope<'player.left', { playerId: number; reason: string }>;
export type PlayerReconnectingMessage = ServerEnvelope<'player.reconnecting', { playerId: number; graceMs: number }>;
export type SpectateChangedMessage = ServerEnvelope<'spectate.changed', { playerId: number; spectating: boolean }>;

/** 저빈도 연출이라 바이너리 섹션이 아니라 JSON으로 보낸다. 놓쳐도 게임 상태는 스냅샷으로 복구된다. */
export type PlayerBlinkedMessage = ServerEnvelope<'player.blinked', {
    playerId: number;
    fromX: number;
    fromY: number;
}>;

export type GameEndedMessage = ServerEnvelope<'game.ended', {
    /** 최후까지 남은 두 명. 공동 승리자이며 등수는 없다. */
    winnerIds: [number, number];
    /** 대기실로 돌아가는 시각(epoch ms). */
    returnsAt: number;
}>;

export type ErrorMessage = ServerEnvelope<'error', {
    requestId: number | null;
    code: ErrorCode;
    retryable: boolean;
}>;

export type PongMessage = ServerEnvelope<'pong', {
    clientTime: number;
    serverTime: number;
    serverTick: number;
}>;

export type ServerMessage =
    | AuthOkMessage
    | LobbyStateMessage
    | LobbyHostChangedMessage
    | GameStartingMessage
    | GameStartedMessage
    | SkillRejectedMessage
    | PlayerTaggedMessage
    | PlayerEliminatedMessage
    | PlayerLeftMessage
    | PlayerReconnectingMessage
    | SpectateChangedMessage
    | PlayerBlinkedMessage
    | GameEndedMessage
    | ErrorMessage
    | PongMessage;

export type ServerMessageType = ServerMessage['type'];

/**
 * 위반 신호. 감지한 자리에서 바로 로그를 찍지 말고 이 구조체 하나를 만들어 단일 지점으로 넘긴다.
 * 초기 소비자는 로그 하나여도 되고, 나중에 저장소나 운영 화면을 붙일 때 소비자만 추가하면 된다.
 */
export const ViolationKind = {
    RateLimit: 'RATE_LIMIT',
    BadLength: 'BAD_LENGTH',
    BadVersion: 'BAD_VERSION',
    BadState: 'BAD_STATE',
    SpectatorInput: 'SPECTATOR_INPUT',
    UnknownMessage: 'UNKNOWN_MESSAGE',
    FrameTooBig: 'FRAME_TOO_BIG',
} as const;
export type ViolationKind = (typeof ViolationKind)[keyof typeof ViolationKind];

export interface ViolationSignal {
    kind: ViolationKind;
    /** 계정 사용자는 number, 게스트는 `g:{uuid}`. */
    userId: number | string;
    roomId: string | null;
    tick: number | null;
    severity: 'low' | 'medium' | 'high';
    /** 탐지 기준이 바뀐 뒤에도 과거 판단을 설명할 수 있어야 한다. */
    ruleVersion: number;
    detail?: Record<string, number | string>;
}
