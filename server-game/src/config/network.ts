/**
 * 네트워크와 루프 수치. 밸런스가 아니라 전송·부하에 관한 값이다.
 *
 * 여기 있는 상한은 대부분 보안 장치다. docs/SERVER_ARCHITECTURE.md의 보안 절이 근거이며,
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
    MAX_UNAUTHENTICATED_PER_IP: 5,
    /** 프로세스 전체 동시 연결 상한. 부하 측정 뒤 확정한다. */
    MAX_CONNECTIONS: 2_000,

    // ── 프레임 크기 ──
    /** 입력 패킷은 6바이트 고정이다. 여유를 조금 두되 넘으면 연결을 끊는다. */
    MAX_BINARY_FRAME_BYTES: 64,
    MAX_JSON_FRAME_BYTES: 2_048,

    // ── 빈도 ──
    MAX_INPUT_PACKETS_PER_SEC: 90,
    MAX_JSON_COMMANDS_PER_SEC: 20,
    EMOJI_COOLDOWN_MS: 2_000,

    // ── backpressure ──
    /** 이 이상 쌓이면 교체 가능한 위치 스냅샷을 생략한다. 누적되어야 하는 변경은 생략하지 않는다. */
    SOCKET_BUFFER_SOFT_LIMIT_BYTES: 64 * 1024,
    SOCKET_BUFFER_HARD_LIMIT_BYTES: 512 * 1024,
    /** hard limit을 이 시간 이상 넘기면 연결을 종료한다. */
    SOCKET_BUFFER_HARD_LIMIT_GRACE_MS: 3_000,

    // ── 예약과 재접속 ──
    SEAT_RESERVATION_TTL_MS: 15_000,
    RECONNECT_GRACE_MS: 10_000,

    // ── 방 수명 ──
    COUNTDOWN_MS: 3_000,
    POST_GAME_MS: 30_000,

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
