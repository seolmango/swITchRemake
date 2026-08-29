/**
 * 환경 값. 여기가 이 프로세스에서 `process.env`를 읽는 **유일한** 곳이다.
 *
 * Docker는 마지막 단계지만, 그 전부터 서버가 파일 경로나 localhost에 의존하지 않게 하려면
 * 인프라 값이 한 곳에 모여 있어야 한다. 다른 파일에서 `process.env`를 읽기 시작하면
 * 배포할 때 무엇을 주입해야 하는지 아무도 모르게 된다.
 */

import { loadRootEnvFile } from './load-env';

loadRootEnvFile();

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
    PUBLIC_WS_PATH: optional('GAME_PUBLIC_WS_PATH', `/game-ws/${optional('GAME_SERVER_ID', 'local')}`),
    /**
     * 이 프로세스가 동시에 들고 있을 방의 상한.
     *
     * 예전에는 코드에 자리만 있고 아무도 값을 넣지 않아 무한대였다. 그러면 부하 분산기가
     * **밀어붙일 천장이 없다** — 서버가 다 터져 가도 "그나마 덜 나쁜 놈"을 골라 계속 방을
     * 꽂아넣는다. 거절할 줄 아는 것이 분산의 전제다.
     *
     * 100은 측정으로 나온 값이 아니라 보수적인 출발점이다. 8인 풀방 tick 측정이 끝나면
     * 실제 수치로 바꾼다.
     */
    MAX_ROOMS: num('GAME_MAX_ROOMS', 100),
    PORT: num('GAME_PORT', 4000),
    HOST: optional('GAME_HOST', '0.0.0.0'),
    /**
     * 게이트웨이가 이 프로세스에 닿을 때 쓸 호스트. heartbeat에 실린다.
     *
     * HOST와 다른 이유: HOST는 '무엇을 듣는가'(0.0.0.0)이고 이건 '어디로 오면 되는가'다.
     * 0.0.0.0으로 접속할 수는 없다.
     */
    INTERNAL_HOST: optional('GAME_INTERNAL_HOST', '127.0.0.1'),

    /** Redis 키에 강제로 붙는 환경 prefix. 없으면 dev와 prod가 같은 keyspace를 쓰게 된다. */
    ENV: optional('APP_ENV', 'dev'),
    REDIS_HOST: optional('REDIS_HOST', 'localhost'),
    REDIS_PORT: num('REDIS_PORT', 6379),
    REDIS_PASSWORD: optional('REDIS_PASSWORD', ''),
    /** Emergency-only override for a known live GAME_SERVER_ID collision. */
    ALLOW_DUPLICATE_SERVER_ID: optional('GAME_ALLOW_DUPLICATE_SERVER_ID', 'false') === 'true',

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

    /**
     * MapBuilder가 만든 서버용 맵 번들. build artifact로 함께 배포한다.
     * 런타임에 CSV를 다시 읽지 않는다.
     */
    MAP_BUNDLE_PATH: optional('GAME_MAP_BUNDLE', './maps/server_maps.json'),

    /** 리플레이 blob 저장 위치. 초기에는 로컬 파일 시스템으로 충분하다. */
    REPLAY_STORE: optional('REPLAY_STORE', 'local') as 'local' | 's3',
    REPLAY_LOCAL_DIR: optional('REPLAY_LOCAL_DIR', './replays'),
    REPLAY_ENABLED: optional('REPLAY_ENABLED', 'false') === 'true',
    /*
     * 리플레이 서명 키. 없으면 서명하지 않는다 — 개발 중에는 그것이 정상이다.
     * PKCS#8 PEM을 base64로 한 줄에 담는다(env에 줄바꿈을 넣지 않으려는 것뿐이다).
     */
    REPLAY_SIGNING_KEY: optional('REPLAY_SIGNING_KEY', ''),
    REPLAY_SIGNING_KEY_ID: optional('REPLAY_SIGNING_KEY_ID', ''),
});

export type InfraConfig = typeof INFRA;
