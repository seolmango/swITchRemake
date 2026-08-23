/**
 * 환경 값. 여기가 이 프로세스에서 `process.env`를 읽는 **유일한** 곳이다.
 *
 * Docker는 마지막 단계지만, 그 전부터 서버가 파일 경로나 localhost에 의존하지 않게 하려면
 * 인프라 값이 한 곳에 모여 있어야 한다. 다른 파일에서 `process.env`를 읽기 시작하면
 * 배포할 때 무엇을 주입해야 하는지 아무도 모르게 된다.
 */

function required(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === '') {
        throw new Error(`환경 변수 ${name}이 필요합니다. .env.example을 참고하세요.`);
    }
    return value;
}

function optional(name: string, fallback: string): string {
    const value = process.env[name];
    return value === undefined || value === '' ? fallback : value;
}

function num(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`환경 변수 ${name}은 숫자여야 합니다: ${raw}`);
    return parsed;
}

function list(name: string): string[] {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return [];
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const INFRA = Object.freeze({
    /** 이 프로세스의 고유 id. 예: game-seoul-01-p2. 배정과 티켓 검증의 기준이다. */
    SERVER_ID: required('GAME_SERVER_ID'),
    /** 리버스 프록시가 이 프로세스로 보낼 때 쓰는 공개 경로. 클라이언트에 그대로 내려간다. */
    PUBLIC_WS_PATH: optional('GAME_PUBLIC_WS_PATH', `/game/${optional('GAME_SERVER_ID', 'local')}`),
    PORT: num('GAME_PORT', 4000),
    HOST: optional('GAME_HOST', '0.0.0.0'),

    /** Redis 키에 강제로 붙는 환경 prefix. 없으면 dev와 prod가 같은 keyspace를 쓰게 된다. */
    ENV: optional('APP_ENV', 'dev'),
    REDIS_HOST: optional('REDIS_HOST', 'localhost'),
    REDIS_PORT: num('REDIS_PORT', 6379),
    REDIS_PASSWORD: optional('REDIS_PASSWORD', ''),

    /**
     * WebSocket upgrade를 허용할 Origin 목록. 비어 있으면 모두 거절한다.
     * WebSocket은 동일 출처 정책을 적용받지 않으므로 이 검사가 유일한 방어선이다.
     */
    ALLOWED_ORIGINS: list('GAME_ALLOWED_ORIGINS'),
    /**
     * 이 주소에서 온 요청에 한해 프록시가 넣은 client IP 헤더를 신뢰한다.
     * 비어 있으면 어떤 헤더도 믿지 않고 소켓 주소를 쓴다. rate limit이 IP 기반이라 중요하다.
     */
    TRUSTED_PROXIES: list('GAME_TRUSTED_PROXIES'),

    /** 경기 결과와 리플레이에 기록된다. 배포 파이프라인이 주입한다. */
    BUILD_ID: optional('BUILD_ID', 'dev'),

    /** 리플레이 blob 저장 위치. 초기에는 로컬 파일 시스템으로 충분하다. */
    REPLAY_STORE: optional('REPLAY_STORE', 'local') as 'local' | 's3',
    REPLAY_LOCAL_DIR: optional('REPLAY_LOCAL_DIR', './replays'),
    REPLAY_ENABLED: optional('REPLAY_ENABLED', 'false') === 'true',
});

export type InfraConfig = typeof INFRA;
