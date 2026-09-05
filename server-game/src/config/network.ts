import { ROOM_TIMING } from 'shared';
/**
 * 네트워크와 루프 수치. 밸런스가 아니라 전송·부하에 관한 값이다.
 *
 * 여기 있는 상한은 대부분 보안 장치다. BASE.md의 보안·레이트리밋 절(§3, §9)이 근거이며,
 * 값을 완화할 때는 그 절을 함께 읽는다.
 */

export const NETWORK = Object.freeze({
    // ── 루프 ──
    SIMULATION_HZ: 60,
    SNAPSHOT_HZ: 30,
    /** 한 프레임이 밀렸을 때 따라잡을 최대 step 수. 넘으면 남은 누적 시간을 버리고 tick은 건너뛰지 않는다. */
    MAX_CATCHUP_STEPS: 5,
    /** 이 값을 지속적으로 넘으면 서버를 draining 처리해 신규 방을 받지 않는다. */
    LOOP_LAG_DRAIN_THRESHOLD_MS: 50,

    // ── 연결 ──
    /** 접속 후 이 시간 안에 `auth` 메시지가 오지 않으면 끊는다. */
    AUTH_TIMEOUT_MS: 5_000,
    /** 인증 전 연결의 IP당 개수 상한. */
    // NAT 뒤 여러 탭이 인증을 병렬로 시작할 수 있어, 정상 최악 10명과 재시도를 수용한다.
    MAX_UNAUTHENTICATED_PER_IP: 15,
    /** 인증 뒤에도 한 IP가 프로세스의 모든 자리를 차지하지 못하게 한다. */
    // PC방ㆍ학교 NAT를 넉넉히 수용하되, 게스트 id를 갈아 끼우는 한 출처에는 유한한 끝을 둔다.
    MAX_AUTHENTICATED_PER_IP: 100,
    /** 프로세스 전체 동시 연결 상한. 부하 측정 뒤 확정한다. */
    MAX_CONNECTIONS: 2_000,

    // ── 프레임 크기 ──
    /** 입력 패킷은 6바이트 고정이다. 여유를 조금 두되 넘으면 연결을 끊는다. */
    MAX_BINARY_FRAME_BYTES: 64,
    MAX_JSON_FRAME_BYTES: 2_048,

    // ── 빈도 ──
    MAX_INPUT_PACKETS_PER_SEC: 90,
    MAX_JSON_COMMANDS_PER_SEC: 20,
    /** NAT 전체가 나눠 쓰는 예산. 연결별 상한보다 넓어 정상 다중 사용자를 한 명처럼 막지 않는다. */
    MAX_IP_INPUT_PACKETS_PER_SEC: 900,
    MAX_IP_JSON_COMMANDS_PER_SEC: 200,
    EMOJI_COOLDOWN_MS: 2_000,

    // ── 리플레이 다운로드 ──
    /** 공개 HTTP flood가 일회용 표 조회를 Redis 부하로 증폭하지 못하게 하는 IP당 분당 상한. */
    MAX_REPLAY_REQUESTS_PER_MINUTE: 30,
    /** readFile 기반 저장소가 큰 파일을 동시에 너무 많이 메모리에 올리지 못하게 한다. */
    MAX_CONCURRENT_REPLAY_DOWNLOADS: 4,
    /** 오프라인 재생기가 파일을 통째로 읽기 전에 거르는 상한. 경기별 spool 상한과 같은 크기로 둔다. */
    MAX_REPLAY_FILE_BYTES: 256 * 1024 * 1024,
    /** 조각 선언이 망가진 호출 경로에서도 스트리밍 압축 해제가 무한히 커지지 않게 하는 최종 상한. */
    MAX_REPLAY_CHUNK_RAW_BYTES: 16 * 1024 * 1024,

    // ── backpressure ──
    /** 이 이상 쌓이면 교체 가능한 위치 스냅샷을 생략한다. 누적되어야 하는 변경은 생략하지 않는다. */
    SOCKET_BUFFER_SOFT_LIMIT_BYTES: 64 * 1024,
    SOCKET_BUFFER_HARD_LIMIT_BYTES: 512 * 1024,
    /** hard limit을 이 시간 이상 넘기면 연결을 종료한다. */
    SOCKET_BUFFER_HARD_LIMIT_GRACE_MS: 3_000,

    // ── 예약과 재접속 ──
    SEAT_RESERVATION_TTL_MS: 15_000,
    RECONNECT_GRACE_MS: 5_000,

    // ── 방 수명 ──
    COUNTDOWN_MS: 3_000,
    /** 원본은 shared다 — 결과창 길이는 클라이언트도 알아야 막대를 그린다(§0). */
    POST_GAME_MS: ROOM_TIMING.POST_GAME_MS,

    // ── 시작 잠금 ──
    /** 참가가 걸어주는 잠금. 들어온 사람이 로드아웃을 고를 시간이다. */
    START_LOCK_ON_JOIN_MS: 5_000,
    /** 맵 변경이 걸어주는 잠금. 맵에 따라 스킬 선택이 달라진다. */
    START_LOCK_ON_MAP_CHANGE_MS: 10_000,
    /**
     * 참가로 인한 잠금의 누적 상한과 그 관찰 창.
     * 이게 없으면 반복 입퇴장으로 방장이 영원히 시작하지 못한다.
     * 맵 변경 잠금은 방장만 걸 수 있으므로 이 상한에서 제외한다.
     */
    START_LOCK_JOIN_BUDGET_MS: 15_000,
    START_LOCK_JOIN_BUDGET_WINDOW_MS: 60_000,

    // ── 명령 평면 ──
    CONTROL_REPLY_TIMEOUT_MS: 2_000,
    /** consumer가 죽어 pending으로 남은 stream 항목을 회수하기까지의 시간. */
    STREAM_AUTOCLAIM_IDLE_MS: 30_000,
    /** 모든 stream에 건다. 상한이 없으면 소비자 장애가 그대로 Redis 메모리 고갈이 된다. */
    STREAM_MAXLEN: 10_000,
    OPERATION_RESULT_TTL_MS: 60_000,
});

export const SIMULATION_STEP_MS = 1000 / NETWORK.SIMULATION_HZ;
export const SNAPSHOT_INTERVAL_TICKS = Math.round(NETWORK.SIMULATION_HZ / NETWORK.SNAPSHOT_HZ);

export type NetworkConfig = typeof NETWORK;
