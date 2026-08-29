/**
 * 매칭 서버 <-> 인게임 서버 제어 평면 계약.
 * docs/SERVER_ARCHITECTURE.md의 "매칭 서버와 인게임 서버 사이의 계약" 절이 원본이다.
 *
 * 이 파일이 두 담당자가 서로를 기다리지 않고 작업하기 위한 경계다. 바꾸려면 양쪽이 함께 바꾼다.
 */

import type { LobbyStats, RoomMode } from '../protocol/events';
import type { SkillId } from '../protocol/skills';

export const CONTROL_VERSION = 1;

export const CommandType = {
    CreateRoom: 'CREATE_ROOM',
    ReserveJoin: 'RESERVE_JOIN',
    ReserveResume: 'RESERVE_RESUME',
    ReleaseSeat: 'RELEASE_SEAT',
    KickUser: 'KICK_USER',
    /**
     * 이 서버를 draining으로 돌린다. 신규 방·참가는 거절하고, 남은 방이 다 빌 때까지 돌다가
     * 스스로 종료한다.
     *
     * 신호(SIGTERM) 대신 제어 평면으로 보내는 이유는 두 가지다. 하나는 Windows에 SIGTERM이
     * 없어서 Node가 핸들러를 부르지 않고 프로세스를 즉시 죽인다는 것 — 경기 중인 사람이 전부
     * 그 자리에서 튕긴다. 다른 하나는 감독자가 인게임 서버와 같은 기계에 있다는 보장이 없다는
     * 것이다. 신호는 프로세스 옆에 있어야 보낼 수 있지만 Redis는 어디서든 닿는다.
     */
    DrainServer: 'DRAIN_SERVER',
    /**
     * 다른 서버가 들고 있던 방을 넘겨받는다.
     *
     * 재우기(`DRAIN_SERVER`)만으로는 방이 다 빌 때까지 몇 분을 기다려야 한다. 대기실에 앉아
     * 있는 방은 옮겨도 되는데 — 시뮬레이션이 안 돌고 있어서 옮길 것이 명단과 방 정보뿐이다 —
     * 그걸 옮기면 축소가 훨씬 빨라진다.
     *
     * **경기 중인 방은 옮기지 않는다.** 그러려면 세계 전체를 직렬화해야 하고, 그건 이득에 비해
     * 위험이 크다. 경기가 끝나 대기실로 돌아온 순간이 기회다.
     */
    AdoptRoom: 'ADOPT_ROOM',
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
    /**
     * 이 명령의 답을 넣을 stream. **보낸 인스턴스만 읽는 자기 전용 stream**이다.
     *
     * 예전에는 모든 매칭 서버가 하나의 응답 stream을 같은 소비자 그룹으로 읽었다. Redis 소비자
     * 그룹은 항목을 소비자들에게 **나눠** 주므로, 다른 인스턴스가 자기 `pending`에 없는 응답을
     * 받아 ack해 버리면 원 요청자는 아무것도 못 받고 2초 복구 타이머까지 기다렸다.
     * 인스턴스가 N대면 응답의 (N-1)/N이 그렇게 사라진다 — 수평 확장하는 순간 모든 방 생성이 2초가 된다.
     *
     * 답을 받을 사람이 주소를 같이 적어 보내면 그 문제가 생기지 않는다.
     */
    replyTo: string;
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
    /** 로비 카드에 띄울 전적. 게스트는 null. 인게임 서버는 DB를 모르므로 여기서 실어 보낸다. */
    ownerStats: LobbyStats | null;
    capacity: number;
    mapId: string;
    /** 생략하면 일반 경기. 훈련장은 방 목록에도 빠른 참가에도 나오지 않는다. */
    mode?: RoomMode;
}

export interface ReserveJoinPayload {
    roomId: string;
    userId: ActorId;
    nickname: string;
    /** 로비 카드에 띄울 전적. 게스트는 null. */
    stats: LobbyStats | null;
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

/**
 * 옮겨 가는 명단 한 줄.
 *
 * 소켓은 옮길 수 없다 — 프로세스에 붙은 TCP 연결이다. 그래서 받는 쪽은 이 사람들을 **끊겼지만
 * 유예 안에 있는 상태**로 만들어 둔다. 실제로 그것이 사실이고, 그러면 클라이언트의 기존 재접속
 * 경로(`RESERVE_RESUME`)가 그대로 통한다 — 새 메시지도, 클라이언트 수정도 필요 없다.
 */
export interface AdoptedRoomMember {
    userId: ActorId;
    playerId: number;
    slot: number;
    nickname: string;
    guest: boolean;
    stats: LobbyStats | null;
    loadout: SkillId;
    joinedOrder: number;
    colorIndex: number;
    isHost: boolean;
}

export interface AdoptRoomPayload {
    /** 엉뚱한 서버가 받지 않도록 보낸 쪽이 대상을 적는다. */
    serverId: string;
    roomId: string;
    roomCode: string;
    matchId: string;
    name: string;
    password: string | null;
    capacity: number;
    mapId: string;
    mode: RoomMode;
    members: AdoptedRoomMember[];
}

export interface DrainServerPayload {
    /** 엉뚱한 서버를 재우지 않도록 보낸 쪽이 대상을 적는다. 다르면 거절한다. */
    serverId: string;
}

export interface DrainServerResult {
    /** 명령을 받은 시점에 남아 있던 방 수. 감독자가 얼마나 기다릴지 가늠하는 데 쓴다. */
    remainingRooms: number;
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
    [CommandType.DrainServer]: { payload: DrainServerPayload; result: DrainServerResult };
    [CommandType.AdoptRoom]: { payload: AdoptRoomPayload; result: Record<string, never> };
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
    /**
     * 게이트웨이가 이 서버에 닿는 주소(`http://host:port`).
     *
     * **공개 주소가 아니다.** 사용자는 게이트웨이 한 곳만 알고, 자기가 어느 인게임 서버에
     * 붙었는지 알 필요가 없다. 이 값은 게이트웨이가 경로(`/game-ws/{serverId}`)를 보고
     * 어디로 넘길지 정하는 데만 쓴다.
     *
     * 정적 설정 파일이 아니라 heartbeat에 싣는 이유는, 서버가 늘고 줄 때 아무도 설정을
     * 고치지 않아도 되게 하기 위해서다. 뜨면 알아서 경로가 생기고 죽으면 TTL로 사라진다.
     */
    internalAddress: string;
    /**
     * 이 서버가 동시에 들고 있을 방의 상한.
     *
     * 배정하는 쪽이 이 값을 봐야 상한이 뜻을 갖는다. 안 보면 가득 찬 서버에 방을 꽂아 넣고
     * `SERVER_FULL`을 돌려받는데, 그건 상한이 아니라 그냥 에러다.
     */
    maxRooms: number;
}

/**
 * 매칭 서버 인스턴스가 자기 상태를 알리는 heartbeat.
 *
 * 게임 서버의 것과 같은 주기·TTL을 쓴다. **라우팅에는 쓰지 않는다** — 매칭 서버 앞에는
 * 이미 리버스 프록시가 있고 이 값은 운영자 화면이 "몇 개가 살아 있고 얼마나 받고 있는지"를
 * 보는 데만 쓴다. 그래서 주소를 싣지 않는다.
 */
export interface MatchServerHeartbeat {
    instanceId: string;
    buildVersion: string;
    protocolVersion: number;
    /**
     * 최근 60초 동안 이 인스턴스가 처리한 HTTP 요청 수.
     *
     * 요청마다 Redis를 두드리지 않는다 — 그러면 측정이 부하가 된다. 프로세스 안에서 초 단위
     * 링버퍼로 세고 heartbeat에 실어 보낸다.
     */
    requestsPerMinute: number;
    /** 인게임 서버의 응답을 기다리고 있는 제어 명령 수. 밀리면 여기부터 부푼다. */
    pendingCommands: number;
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
        matchServer: (instanceId: string) => p(`match-server:${instanceId}`),
        matchServersAlive: () => p('match-servers:alive'),
        room: (roomId: string) => p(`room:${roomId}`),
        roomCode: (roomCode: string) => p(`room-code:${roomCode}`),
        roomsWaiting: () => p('rooms:waiting'),
        userActiveRoom: (userId: ActorId) => p(`user:${userId}:active-room`),
        guestSession: (sessionId: string) => p(`guest-session:${sessionId}`),
        roomRejoin: (roomId: string, userId: ActorId) => p(`room-rejoin:${roomId}:${userId}`),
        commands: (serverId: string) => p(`game-server:${serverId}:commands`),
        /**
         * 매칭 서버 인스턴스 하나가 자기 응답만 읽는 stream.
         *
         * 읽는 쪽이 TTL을 계속 갱신한다. 인스턴스가 죽으면 아무도 갱신하지 않으므로 키가 스스로
         * 사라진다 — 죽은 인스턴스의 stream이 Redis에 쌓이지 않는다.
         */
        repliesFor: (consumerId: string) => p(`matching-server:replies:${consumerId}`),
        /**
         * 주소를 알 수 없는 응답이 가는 곳. 명령 자체가 깨져서 `replyTo`를 읽지 못했을 때다.
         * 아무도 읽지 않는다 — 원 요청자는 어차피 상관관계를 만들 수 없어 타임아웃으로 복구한다.
         */
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
