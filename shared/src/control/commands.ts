/**
 * 매칭 서버 <-> 인게임 서버 제어 평면 계약.
 * docs/SERVER_ARCHITECTURE.md의 "매칭 서버와 인게임 서버 사이의 계약" 절이 원본이다.
 *
 * 이 파일이 두 담당자가 서로를 기다리지 않고 작업하기 위한 경계다. 바꾸려면 양쪽이 함께 바꾼다.
 */

export const CONTROL_VERSION = 1;

export const CommandType = {
    CreateRoom: 'CREATE_ROOM',
    ReserveJoin: 'RESERVE_JOIN',
    ReserveResume: 'RESERVE_RESUME',
    ReleaseSeat: 'RELEASE_SEAT',
    KickUser: 'KICK_USER',
} as const;
export type CommandType = (typeof CommandType)[keyof typeof CommandType];

export const ControlErrorCode = {
    ServerDraining: 'SERVER_DRAINING',
    ServerFull: 'SERVER_FULL',
    InvalidMap: 'INVALID_MAP',
    RoomNotFound: 'ROOM_NOT_FOUND',
    RoomFull: 'ROOM_FULL',
    /** COUNTDOWN 이후 상태이거나 방장이 방을 잠갔다. */
    RoomLocked: 'ROOM_LOCKED',
    BadPassword: 'BAD_PASSWORD',
    AlreadyInRoom: 'ALREADY_IN_ROOM',
    KickedFromRoom: 'KICKED_FROM_ROOM',
    RejoinCooldown: 'REJOIN_COOLDOWN',
    NoGraceSlot: 'NO_GRACE_SLOT',
    /** deadlineAt을 넘겨 도착했다. 부수 효과 없이 만료 처리한다. */
    Expired: 'EXPIRED',
    Internal: 'INTERNAL',
} as const;
export type ControlErrorCode = (typeof ControlErrorCode)[keyof typeof ControlErrorCode];

/**
 * 클라이언트에 그대로 내려보내면 안 되는 코드.
 * `ROOM_NOT_FOUND`와 `BAD_PASSWORD`를 구분해 주면 비공개 방의 존재 여부가 새어나간다.
 */
export const CLIENT_MASKED_ERRORS: readonly ControlErrorCode[] = [
    ControlErrorCode.RoomNotFound,
    ControlErrorCode.BadPassword,
];

export interface ControlCommand<T = unknown> {
    v: typeof CONTROL_VERSION;
    /** UUID v4. 멱등 키다. 재전달된 같은 requestId는 부수 효과 없이 같은 결과를 돌려준다. */
    requestId: string;
    type: CommandType;
    issuedAt: number;
    /**
     * 이 시각을 넘겨 도착한 명령은 처리하지 않는다.
     * 매칭 서버가 이미 포기한 요청이 몇 초 뒤 처리되어 유령 방이 남는 것을 막는다.
     */
    deadlineAt: number;
    payload: T;
}

export interface ControlReply<T = unknown> {
    v: typeof CONTROL_VERSION;
    requestId: string;
    serverId: string;
    ok: boolean;
    /** ok가 false일 때만 채운다. */
    code: ControlErrorCode | null;
    payload: T | null;
}

/* ────────────────────────────── payload ────────────────────────────── */

/** 게스트는 `g:{uuid}` 문자열, 계정 사용자는 number. */
export type ActorId = number | string;

export function isGuestActor(id: ActorId): boolean {
    return typeof id === 'string';
}

export interface CreateRoomPayload {
    matchId: string;
    roomCode: string;
    roomName: string;
    /** 없으면 공개 방. 원문은 방 소유 인게임 서버 메모리에만 머문다. */
    password: string | null;
    ownerUserId: ActorId;
    ownerNickname: string;
    capacity: number;
    mapId: string;
}

export interface ReserveJoinPayload {
    roomId: string;
    userId: ActorId;
    nickname: string;
    password: string | null;
}

export interface ReserveResumePayload {
    roomId: string;
    userId: ActorId;
}

export interface ReleaseSeatPayload {
    roomId: string;
    userId: ActorId;
}

export interface KickUserPayload {
    roomId: string;
    userId: ActorId;
    reason: string;
}

/** 자리 예약 성공 응답. 티켓은 이 응답에만 실려 나가고 어디에도 다시 기록되지 않는다. */
export interface SeatGrant {
    wsPath: string;
    /** CSPRNG 256비트 불투명 토큰. 인게임 서버는 SHA-256 해시만 보관한다. */
    ticket: string;
    expiresAt: number;
}

export interface CreateRoomResult extends SeatGrant {
    roomId: string;
    roomCode: string;
    /** The actual map the room was created with — the 'random' sentinel is already resolved by here. */
    mapId: string;
}

export interface ControlCommandMap {
    [CommandType.CreateRoom]: { payload: CreateRoomPayload; result: CreateRoomResult };
    [CommandType.ReserveJoin]: { payload: ReserveJoinPayload; result: SeatGrant };
    [CommandType.ReserveResume]: { payload: ReserveResumePayload; result: SeatGrant };
    [CommandType.ReleaseSeat]: { payload: ReleaseSeatPayload; result: Record<string, never> };
    [CommandType.KickUser]: { payload: KickUserPayload; result: Record<string, never> };
}

/* ────────────────────────────── heartbeat ────────────────────────────── */

export interface GameServerHeartbeat {
    serverId: string;
    buildVersion: string;
    protocolVersion: number;
    rulesVersion: string;
    mapBundleHash: string;
    waitingRooms: number;
    playingRooms: number;
    connections: number;
    loopLagMs: number;
    draining: boolean;
    updatedAt: number;
}

/** heartbeat 주기와 키 TTL. TTL은 주기의 3배라 한 번 걸러도 살아 있는 것으로 본다. */
export const HEARTBEAT_INTERVAL_MS = 2_000;
export const HEARTBEAT_TTL_MS = 6_000;

/* ────────────────────────────── Redis 키 ────────────────────────────── */

/**
 * 키 이름을 문자열로 직접 조립하지 않는다. 환경 prefix를 빠뜨린 키 하나가
 * dev와 prod를 같은 keyspace에서 섞는다.
 */
export function makeKeys(env: string) {
    const p = (s: string) => `${env}:${s}`;
    return {
        gameServer: (serverId: string) => p(`game-server:${serverId}`),
        gameServersAlive: () => p('game-servers:alive'),
        room: (roomId: string) => p(`room:${roomId}`),
        roomCode: (roomCode: string) => p(`room-code:${roomCode}`),
        roomsWaiting: () => p('rooms:waiting'),
        userActiveRoom: (userId: ActorId) => p(`user:${userId}:active-room`),
        guestSession: (sessionId: string) => p(`guest-session:${sessionId}`),
        roomRejoin: (roomId: string, userId: ActorId) => p(`room-rejoin:${roomId}:${userId}`),
        commands: (serverId: string) => p(`game-server:${serverId}:commands`),
        replies: () => p('matching-server:replies'),
        gameResults: () => p('game-results'),
        operation: (requestId: string) => p(`operation:${requestId}`),
    };
}
export type RedisKeys = ReturnType<typeof makeKeys>;

/** consumer group 이름. 소비자가 여럿이어도 명령이 중복 처리되지 않게 고정한다. */
export const ConsumerGroup = {
    Commands: 'cg:game',
    Replies: 'cg:match',
    Results: 'cg:result-worker',
} as const;
