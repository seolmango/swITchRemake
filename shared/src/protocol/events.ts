/**
 * 저빈도 JSON 메시지 카탈로그. 이 파일이 카탈로그의 원본이다. 지켜야 할 성질은 BASE.md §6.2에 있다.
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

/**
 * 방이 무엇을 하는 곳인가.
 *
 * 훈련장을 별도의 방 종류로 두는 이유는, 클라이언트가 물리를 다시 구현한 로컬 목업으로 만들면
 * 서버와 값이 갈라지기 때문이다(예전 `/sandbox`가 실제로 그랬다). 같은 시뮬레이션, 같은
 * 네트워크 구간을 쓰되 방 규칙만 바꾼다.
 */
export const RoomMode = {
    Match: 'match',
    Training: 'training',
} as const;
export type RoomMode = (typeof RoomMode)[keyof typeof RoomMode];

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
    /**
     * 결과를 내보낼 자리가 없어 새 경기를 받지 않는다. Redis가 막혀 outbox가 찼을 때다.
     *
     * `Internal`로 뭉뚱그리지 않는 이유는 사용자가 할 일이 다르기 때문이다. 이건 잠시 뒤 다시
     * 누르면 되는 상태다 — outbox는 Redis가 살아나면 스스로 비워진다.
     */
    ResultBacklog: 'RESULT_BACKLOG',
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
    /**
     * 서버 사정으로 끊었으니 다시 붙으라는 뜻. 방이 다른 서버로 옮겨 갈 때 쓴다.
     *
     * 클라이언트는 close 코드가 아니라 직전에 받은 `error`의 `retryable`로 재접속을 정한다.
     * 그래서 이 코드로 끊을 때는 `error`를 **보내지 않는다** — 보내면 화면에 실패가 뜨는데,
     * 사용자 입장에서는 아무 일도 일어나지 않은 것이어야 한다.
     */
    TryAgainLater: 1013,
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
/**
 * 대기실 자리 옮기기. `slot`은 1..capacity다.
 *
 * `playerId`와 다른 개념이다 — `playerId`는 연결과 시뮬레이션이 쓰는 불변 식별자고, `slot`은 대기실
 * 화면에서 몇 번째 칸에 앉아 있는지다. 자리를 옮겨도 `playerId`는 그대로다.
 */
export type LobbySetSlotMessage = ClientEnvelope<'lobby.setSlot', { slot: number }>;
export type LobbyStartMessage = ClientEnvelope<'lobby.start', Record<string, never>>;
export type LobbyLeaveMessage = ClientEnvelope<'lobby.leave', Record<string, never>>;
export type LobbySetLoadoutMessage = ClientEnvelope<'lobby.setLoadout', { skills: string[] }>;
export type LobbySpectateMessage = ClientEnvelope<'lobby.spectate', { spectate: boolean }>;
/**
 * 슬롯 1은 스위치(러너 전용), 슬롯 2는 경기 전에 고른 스킬이다.
 * `targetPlayerId`는 스위치에만 쓴다 — 지목 대상은 맵 어디에 있어도 되므로 서버가 좌표로 추론할 수 없다.
 */
export type GameUseSkillMessage = ClientEnvelope<'game.useSkill', { slot: number; targetPlayerId?: number }>;
/**
 * 쓸 수 있는 이모지 번호는 1..8이다.
 *
 * 계약에 적어 두는 이유: 이 범위를 지금까지 클라이언트만 알고 있었고, 서버는 스냅샷 인코딩이
 * u8이라는 이유로 0..255를 통과시켰다. 그러면 서버는 받아서 뿌리는데 클라이언트에는 그릴 그림이
 * 없는 번호가 생긴다 — 남의 화면에서만 아무 일도 안 일어나는 상태다.
 *
 * 그림 파일이 늘어나면 `EMOJI_ID_MAX`를 올린다. 클라이언트가 자기 그림 수와 이 값이 어긋나면
 * 부팅할 때 죽는다(`client/src/game/emoji.ts`) — 한쪽만 올리는 실수를 그 자리에서 잡는다.
 */
export const EMOJI_ID_MIN = 1;
export const EMOJI_ID_MAX = 8;

export const isEmojiId = (value: unknown): boolean =>
    typeof value === 'number' && Number.isInteger(value) && value >= EMOJI_ID_MIN && value <= EMOJI_ID_MAX;

export type GameEmojiMessage = ClientEnvelope<'game.emoji', { emojiId: number }>;
export type PingMessage = ClientEnvelope<'ping', { clientTime: number }>;

/** 훈련장에서 죽은 뒤 다시 시작한다. 경기 방에서는 거부된다. */
export type TrainingRespawnMessage = ClientEnvelope<'training.respawn', Record<string, never>>;

export type ClientMessage =
    | AuthMessage
    | LobbySetMapMessage
    | LobbyKickMessage
    | LobbyPassHostMessage
    | LobbySetLockedMessage
    | LobbySetSlotMessage
    | LobbyStartMessage
    | LobbyLeaveMessage
    | LobbySetLoadoutMessage
    | LobbySpectateMessage
    | GameUseSkillMessage
    | GameEmojiMessage
    | TrainingRespawnMessage
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

/**
 * 로비 카드에 띄우는 전적 요약. 게스트는 `null`이다 — 게스트는 전적이 남지 않는다.
 *
 * 비율을 이미 계산해서 싣는다. games/wins만 보내고 클라이언트가 나누면 같은 사람의 승률이
 * 프로필 화면(`GET /users/me/stats`)과 로비에서 다르게 반올림되는 날이 온다. 계산은
 * 매칭 서버 한 곳에서만 한다.
 */
export interface LobbyStats {
    games: number;
    wins: number;
    /** 백분율, 소수 한 자리(예: 66.7). */
    winRate: number;
    /** 백분율, 소수 한 자리. 시도가 없으면 0이다. */
    switchSuccessRate: number;
}

export interface LobbyPlayer {
    playerId: number;
    /** 대기실 자리 번호(1..capacity). playerId와 다르다 — 자리를 옮겨도 playerId는 그대로다. */
    slot: number;
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
    /**
     * 전적 요약. 게스트와, 전적을 아직 못 받은 사람은 `null`이다.
     *
     * 인게임 서버는 DB를 모른다. 이 값은 매칭 서버가 자리를 예약할 때 실어 보낸 것을 그대로
     * 돌려주는 것이다 — 인게임 서버가 직접 조회하면 로비를 그릴 때마다 DB를 두드리게 된다.
     */
    stats: LobbyStats | null;
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
    /**
     * 방을 만든 사람이 붙인 이름.
     *
     * **서버가 알려줘야 한다.** 예전에는 클라이언트가 방을 만들 때 입력한 값이나 방 목록에서 본 값을
     * 들고 다녔는데, 그러면 코드로 참가하거나 로비에서 새로고침한 사람은 넘겨받을 게 없어서 화면에
     * 방 이름 대신 36자 roomId가 그대로 떴다. 이름은 방의 상태이므로 상태 이벤트에 실린다.
     */
    roomName: string;
    mapId: string;
    /** 훈련장은 규칙이 다르다 — 자기장이 멈추고, 혼자 시작할 수 있고, 전적이 남지 않는다. */
    mode: RoomMode;
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

/**
 * 사거리를 가진 스킬(스위치·탈진)을 **썼다**. 성공 여부와 무관하게 나간다 — 사거리 밖이었다는
 * 사실도 보는 사람에게는 정보다(레거시도 시도할 때마다 원을 그렸다).
 *
 * 반지름은 싣지 않는다. `skill`에 대응하는 사거리는 `game.starting`의 `gameplay`가 이미
 * 알려 줬고, 같은 값을 두 경로로 보내면 언젠가 갈라진다.
 *
 * 클라이언트는 시전자가 지금 보이는 경우에만 그린다. 수풀에 숨은 사람의 위치가 연출로 새면 안 된다.
 * 이 메시지 자체는 방 전체에 나가므로 정직하지 않은 클라이언트는 알 수 있다 — `player.blinked`와
 * 같은 수준의 타협이고, 고치려면 연출 이벤트 전체를 시야로 걸러야 한다.
 */
export type PlayerSkillAreaMessage = ServerEnvelope<'player.skillArea', {
    /** `SkillId.Switch` 또는 `SkillId.Exhaust`. 클라이언트가 이 값으로 반지름을 고른다. */
    skill: string;
    playerId: number;
    /** 쓴 순간의 시전자 위치. 원은 여기에 그린다. */
    x: number;
    y: number;
    /**
     * 지목한 상대. **스위치에만 있다.**
     *
     * 탈진은 지목기가 아니라 범위기여서 사거리 안의 모두가 걸린다 — 한 사람을 가리킬 수 없으므로
     * 항상 `null`이다. 원을 무슨 색으로 그릴지는 이 값이 아니라 스킬 종류가 정하고, 그 판단은
     * 클라이언트가 한다(스위치는 지목한 사람 색, 탈진은 시전자 색).
     */
    targetPlayerId: number | null;
}>;

export type GameEndedMessage = ServerEnvelope<'game.ended', {
    /**
     * 방금 끝난 경기의 식별자. 결과 화면(`/matches/{matchId}/result`)으로 가려면 이 값이 필요하다.
     *
     * 방 id로는 안 된다 — 한 방에서 여러 경기가 이어지므로 어느 경기의 결과인지 가려지지 않는다.
     */
    matchId: string;
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
    | PlayerSkillAreaMessage
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
