'use strict';
/**
 * 서버 환경 변수의 유일한 목록.
 *
 * `npm run setup`(생성), `npm run env:check`(검사), `npm run env:docs`(.env.example과
 * docs/configuration.md 생성)가 전부 이 파일을 읽는다. 서버 코드에 환경 변수를 새로 읽기 시작하면
 * 여기에 추가한다 — 빠뜨리면 `scripts/env/env.test.cjs`가 실패한다.
 *
 * 검사 규칙은 서버의 기동 검사를 **미리** 알려 주려는 것이다. 최종 판정은 서버가 한다.
 *
 * 항목의 필드
 *   key       변수 이름
 *   services  읽는 쪽. match | game | gateway | supervisor | compose(Docker Compose 보간)
 *   desc      설명. 생성되는 파일 주석과 문서에 그대로 들어간다
 *   default   비워 두면 서버가 쓰는 값(문서용). 없으면 기본값이 없다는 뜻
 *   required  true면 항상, 'prod'면 APP_ENV=prod일 때만 필수
 *   secret    생성기 이름. 값을 화면·문서에 찍지 않는다
 *   rule      추가 검사(값 → 오류 문구 또는 null)
 *   advanced  true면 생성 파일에 주석으로만 넣는다(대부분 바꿀 일이 없다)
 *   profiles  프로필별 값. dev = 로컬 개발(.env), deploy = Docker 배포(.env.deploy)
 *             값 대신 함수면 setup 옵션을 받아 값을 만든다. `null`이면 그 프로필 파일에 넣지 않는다
 */

const positiveInt = (value) => (/^[1-9][0-9]*$/.test(value) ? null : '양의 정수여야 한다');
const bool = (value) => (value === 'true' || value === 'false' ? null : 'true 또는 false여야 한다');
const minBytes = (n) => (value) => (Buffer.byteLength(value, 'utf8') >= n ? null : `${n}바이트 이상이어야 한다`);
const aesKey = (value) => {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === 32 && decoded.toString('base64') === value ? null : 'base64로 된 32바이트 키여야 한다(openssl rand -base64 32)';
};
const origins = (value) => {
    for (const origin of value.split(',').map((s) => s.trim()).filter(Boolean)) {
        try {
            const url = new URL(origin);
            if (url.origin !== origin) return `"${origin}"은 경로 없이 스킴://호스트[:포트]만 적는다`;
        } catch {
            return `"${origin}"은 올바른 주소가 아니다`;
        }
    }
    return null;
};

const GROUPS = [
    {
        title: '기본',
        vars: [
            {
                key: 'APP_ENV', services: ['match', 'game', 'gateway', 'supervisor'], default: 'dev',
                desc: 'dev | staging | prod. Redis 키 앞에 붙어 환경을 나눈다. prod는 쿠키를 Secure로 만들고, 메일 sink·완화된 속도 제한·무서명 리플레이로는 기동하지 않는다.',
                rule: (v) => (['dev', 'staging', 'prod'].includes(v) ? null : 'dev, staging, prod 중 하나여야 한다'),
                profiles: { dev: 'dev', deploy: (o) => (o.domain ? 'prod' : 'dev') },
            },
            {
                key: 'BUILD_ID', services: ['match', 'game'], default: 'dev',
                desc: '경기 결과와 리플레이에 찍히는 빌드 이름. 배포할 때마다 바꾼다(예: 커밋 SHA).',
                profiles: { dev: 'dev', deploy: 'local' },
            },
        ],
    },
    {
        title: 'PostgreSQL',
        vars: [
            { key: 'DB_HOST', services: ['match'], default: 'localhost', desc: 'DB 주소. Docker 배포에서는 compose가 postgres로 덮어쓴다.', profiles: { dev: 'localhost', deploy: null } },
            { key: 'DB_PORT', services: ['match', 'compose'], default: '5432', desc: 'DB 포트. 로컬 개발에서는 docker-compose.yml이 이 포트로 연다.', rule: positiveInt, profiles: { dev: '5432', deploy: null } },
            { key: 'DB_USER', services: ['match', 'compose'], required: true, desc: 'DB 사용자.', profiles: { dev: 'switch', deploy: 'switch' } },
            { key: 'DB_PASSWORD', services: ['match', 'compose'], required: true, secret: 'password', desc: 'DB 비밀번호.' },
            { key: 'DB_NAME', services: ['match', 'compose'], required: true, desc: 'DB 이름.', profiles: { dev: 'switch', deploy: 'switch' } },
            { key: 'DB_SSL', services: ['match'], default: 'false', desc: 'true면 TLS로 붙고 인증서와 호스트 이름을 검증한다(관리형 DB용).', rule: bool, advanced: true },
        ],
    },
    {
        title: 'Redis',
        vars: [
            { key: 'REDIS_HOST', services: ['match', 'game', 'gateway', 'supervisor'], default: 'localhost', desc: 'Redis 주소. Docker 배포에서는 compose가 redis로 덮어쓴다.', profiles: { dev: 'localhost', deploy: null } },
            { key: 'REDIS_PORT', services: ['match', 'game', 'gateway', 'supervisor', 'compose'], default: '6379', desc: 'Redis 포트.', rule: positiveInt, profiles: { dev: '6379', deploy: null } },
            { key: 'REDIS_PASSWORD', services: ['match', 'game', 'gateway', 'supervisor', 'compose'], required: true, secret: 'password', desc: '비밀번호 없이 뜬 Redis는 같은 네트워크의 누구나 방 배정과 전적을 조작할 수 있다.' },
        ],
    },
    {
        title: '인증 비밀값',
        vars: [
            { key: 'JWT_ACCESS_SECRET', services: ['match'], required: true, secret: 'token', desc: 'access token 서명 키. 세 JWT 키는 32자 이상이고 서로 달라야 한다.', rule: minBytes(32) },
            { key: 'JWT_REFRESH_SECRET', services: ['match'], required: true, secret: 'token', desc: 'refresh token과 쿠키 서명 키.', rule: minBytes(32) },
            { key: 'JWT_GUEST_REFRESH_SECRET', services: ['match'], required: true, secret: 'token', desc: '게스트 refresh token 서명 키. 계정 키와 달라야 게스트 토큰이 새어도 계정으로 넘어가지 못한다.', rule: minBytes(32) },
            { key: 'JWT_ACCESS_EXPIRATION', services: ['match'], default: '900', desc: 'access token 수명(초).', rule: positiveInt, advanced: true },
            { key: 'JWT_REFRESH_EXPIRATION', services: ['match'], default: '1209600', desc: 'refresh token 수명(초).', rule: positiveInt, advanced: true },
            { key: 'JWT_GUEST_EXPIRATION', services: ['match'], default: '900', desc: '게스트 access token 수명(초).', rule: positiveInt, advanced: true },
            { key: 'JWT_GUEST_REFRESH_EXPIRATION', services: ['match'], default: '3600', desc: '게스트 refresh token 수명(초).', rule: positiveInt, advanced: true },
            { key: 'SESSION_IP_HMAC_SECRET', services: ['match'], required: true, secret: 'token', desc: '세션·감사 로그의 IP를 장기 보관용 HMAC으로 바꾸는 키(32바이트 이상).', rule: minBytes(32) },
            { key: 'SESSION_IP_ENCRYPTION_KEY', services: ['match'], required: true, secret: 'aes', desc: '짧게 보관하는 원본 IP를 암호화하는 AES-256-GCM 키.', rule: aesKey },
            { key: 'MFA_TOTP_ENCRYPTION_KEY', services: ['match'], required: true, secret: 'aes', desc: 'OTP 비밀값을 암호화하는 AES-256-GCM 키. SESSION_IP_ENCRYPTION_KEY와 달라야 한다.', rule: aesKey },
            { key: 'MFA_TOTP_ENCRYPTION_KEY_PREVIOUS', services: ['match'], desc: '키를 회전하는 동안만 직전 키를 넣는다. 검증에 성공하면 현재 키로 다시 암호화된다.', rule: aesKey, advanced: true },
            {
                key: 'MFA_TRUSTED_DEVICE_DAYS', services: ['match'], default: '30', desc: '신뢰 기기 등록 기간(일). 1~90.',
                rule: (v) => (/^[0-9]+$/.test(v) && Number(v) >= 1 && Number(v) <= 90 ? null : '1~90 사이 정수여야 한다'), advanced: true,
            },
        ],
    },
    {
        title: '메일',
        vars: [
            {
                key: 'EMAIL_TRANSPORT', services: ['match'], default: 'sink',
                desc: 'sink는 메일을 보내지 않고 Redis `test:mail:{용도}:{email}`에 코드를 남긴다(로컬·e2e). 실제 사용자가 가입하려면 smtp.',
                rule: (v) => (v === 'sink' || v === 'smtp' ? null : 'sink 또는 smtp여야 한다'),
                profiles: { dev: 'sink', deploy: (o) => (o.smtpUser ? 'smtp' : 'sink') },
            },
            { key: 'SMTP_USER', services: ['match'], desc: 'SMTP 계정. SMTP_PASSWORD와 함께 넣는다.', profiles: { dev: '', deploy: (o) => o.smtpUser ?? '' } },
            { key: 'SMTP_PASSWORD', services: ['match'], secret: 'given', desc: 'SMTP 비밀번호(Gmail은 앱 비밀번호).', profiles: { dev: '', deploy: (o) => o.smtpPassword ?? '' } },
            { key: 'SMTP_HOST', services: ['match'], default: 'smtp.gmail.com', desc: 'SMTP 서버.', advanced: true },
            { key: 'SMTP_PORT', services: ['match'], default: '465', desc: 'SMTP 포트.', rule: positiveInt, advanced: true },
            { key: 'SMTP_SECURE', services: ['match'], default: 'true', desc: 'true면 처음부터 TLS(465), false면 STARTTLS(587).', rule: bool, advanced: true },
            { key: 'SMTP_FROM', services: ['match'], default: 'SMTP_USER', desc: '보내는 사람 주소.', advanced: true },
        ],
    },
    {
        title: '리플레이',
        vars: [
            { key: 'REPLAY_ENABLED', services: ['game'], default: 'false', desc: '경기를 리플레이 파일로 기록한다.', rule: bool, profiles: { dev: 'true', deploy: 'true' } },
            { key: 'REPLAY_STORE', services: ['game'], default: 'local', desc: '저장소. 지금은 local(디스크)만 구현돼 있다.', rule: (v) => (v === 'local' ? null : 'local만 구현돼 있다'), advanced: true },
            { key: 'REPLAY_LOCAL_DIR', services: ['game'], default: './replays', desc: '리플레이와 결과 저널(.result-outbox)을 쓰는 폴더. 실행 스크립트와 Docker 이미지가 알맞게 채운다.', advanced: true },
            { key: 'REPLAY_SIGNING_KEY', services: ['game'], required: 'prod', secret: 'replayPrivate', desc: '리플레이 서명 개인키(PKCS#8 PEM을 base64로 한 줄). 인게임 서버만 가진다. 비우면 개발용 무서명 파일을 만든다.' },
            { key: 'REPLAY_SIGNING_KEY_ID', services: ['game'], required: 'prod', secret: 'replayKeyId', desc: '서명 키 이름(16바이트 이하). 파일에 함께 찍힌다.', rule: (v) => (Buffer.byteLength(v) <= 16 ? null : '16바이트 이하여야 한다') },
            { key: 'REPLAY_SIGNING_PUBLIC_KEYS', services: ['match'], secret: 'replayPublic', desc: '재생기가 서명을 확인할 공개키 목록 `keyId:base64,...`. 키를 바꾸는 동안 옛 키도 남겨 두면 예전 파일도 검증된다.' },
        ],
    },
    {
        title: '인게임 서버',
        vars: [
            {
                key: 'GAME_ALLOWED_ORIGINS', services: ['game'], required: true,
                desc: 'WebSocket을 허용할 브라우저 주소(스킴://호스트[:포트]) 목록. 비어 있으면 인게임 서버가 기동하지 않는다.',
                rule: origins,
                profiles: { dev: 'http://localhost:5173', deploy: (o) => (o.domain ? `https://${o.domain}` : 'http://localhost:8080,http://127.0.0.1:8080') },
            },
            { key: 'GAME_MAX_ROOMS', services: ['game'], default: '100', desc: '프로세스 하나가 들 방의 상한. 측정값이 아니라 보수적인 출발점이다.', rule: positiveInt, advanced: true },
            { key: 'GAME_HOST', services: ['game'], default: '0.0.0.0', desc: '인게임 서버가 듣는 주소.', advanced: true },
            { key: 'GAME_INTERNAL_HOST', services: ['game'], default: '127.0.0.1', desc: '게이트웨이가 인게임 서버에 닿을 주소. heartbeat에 실린다.', advanced: true },
            { key: 'GAME_TRUSTED_PROXIES', services: ['game'], desc: '클라이언트 IP 헤더를 믿을 프록시 주소(쉼표, CIDR 가능). 게이트웨이와 그 앞 프록시를 전부 적는다. Docker 배포는 compose가 채운다.', advanced: true },
            { key: 'GAME_SERVER_ID', services: ['game'], desc: '프로세스 고유 id. 감독자가 띄울 때와 `npm run game:start`가 알아서 정한다.', advanced: true },
            { key: 'GAME_PUBLIC_WS_PATH', services: ['game'], default: '/game-ws/{GAME_SERVER_ID}', desc: '반드시 `/game-ws/{GAME_SERVER_ID}`. 실행 스크립트가 맞춰 준다.', advanced: true },
            { key: 'GAME_PORT', services: ['game'], default: '4000', desc: '`game:start`의 포트. 감독자가 띄우는 서버는 빈 포트를 고른다.', rule: (v) => (/^[0-9]+$/.test(v) ? null : '숫자여야 한다'), advanced: true },
            { key: 'GAME_MAP_BUNDLE', services: ['game'], default: 'server-game/maps/server_maps.json', desc: '맵 번들 경로. 실행 스크립트와 Docker 이미지가 채운다. 직접 실행할 때는 절대 경로.', advanced: true },
            { key: 'GAME_ALLOW_DUPLICATE_SERVER_ID', services: ['game'], default: 'false', desc: '비상용. 같은 id의 heartbeat가 살아 있어도 기동한다.', rule: bool, advanced: true },
        ],
    },
    {
        title: '매칭 서버',
        vars: [
            { key: 'PORT', services: ['match'], default: '3000', desc: '매칭 서버 포트.', rule: positiveInt, advanced: true },
            { key: 'MATCH_TRUSTED_PROXIES', services: ['match'], desc: 'X-Forwarded-For를 믿을 프록시 주소(쉼표, CIDR 가능). 리버스 프록시 뒤에서 비우면 모든 요청이 한 IP로 보여 IP 제한이 전역이 된다. Docker 배포는 compose가 채운다.', advanced: true },
            { key: 'MATCH_SERVER_ID', services: ['match'], default: 'match-{임의}', desc: '운영 화면의 요청 집계에 쓰는 인스턴스 이름.', advanced: true },
            { key: 'RATE_LIMIT_RELAXED', services: ['match'], default: 'false', desc: 'true면 속도 제한 한도만 50배로 넓힌다(e2e가 한 IP에서 계정을 수십 개 만들 때). prod에서는 기동을 거부한다.', rule: bool, profiles: { dev: 'false', deploy: 'false' } },
        ],
    },
    {
        title: '보관 기간',
        note: '값을 바꾸면 BASE.md §14.1과 개인정보처리방침(legal/)도 함께 고친다.',
        vars: [
            { key: 'MATCH_RETENTION_DAYS', services: ['match'], default: '30', desc: '전적(경기·참가자) 보관 일수.', rule: positiveInt, advanced: true },
            { key: 'REPLAY_RETENTION_HOURS', services: ['match'], default: '2', desc: '리플레이 보관 시간. 신고 hold가 걸린 것은 남는다.', rule: positiveInt, advanced: true },
            { key: 'SESSION_RETENTION_DAYS', services: ['match'], default: '30', desc: '끝난 세션 행을 남기는 일수.', rule: positiveInt, advanced: true },
            { key: 'SESSION_IP_RETENTION_DAYS', services: ['match'], default: '7', desc: '세션의 암호화 원본 IP 보관 일수.', rule: positiveInt, advanced: true },
            { key: 'AUDIT_LOG_RETENTION_DAYS', services: ['match'], default: '365', desc: '감사 로그 보관 일수.', rule: positiveInt, advanced: true },
            { key: 'AUDIT_IP_RETENTION_DAYS', services: ['match'], default: '7', desc: '감사 로그의 암호화 원본 IP 보관 일수.', rule: positiveInt, advanced: true },
            { key: 'MODERATION_CASE_RETENTION_DAYS', services: ['match'], default: '1825', desc: '종결된 신고 사건 보관 일수.', rule: positiveInt, advanced: true },
            { key: 'SANCTION_RETENTION_DAYS', services: ['match'], default: '1825', desc: '경고·끝난 제재 기록 보관 일수. 영구 정지는 남는다.', rule: positiveInt, advanced: true },
            { key: 'AUTH_SECURITY_EVENT_RETENTION_DAYS', services: ['match'], default: '365', desc: 'refresh 재사용 같은 인증 보안 사건 보관 일수.', rule: positiveInt, advanced: true },
            { key: 'RETENTION_INTERVAL_MINUTES', services: ['match'], default: '10', desc: '정리 작업 간격(분). 첫 회차는 기동 1분 뒤.', rule: positiveInt, advanced: true },
        ],
    },
    {
        title: '게이트웨이',
        vars: [
            { key: 'GATEWAY_PORT', services: ['gateway'], default: '4100', desc: '게이트웨이 포트.', rule: positiveInt, advanced: true },
            { key: 'GATEWAY_HOST', services: ['gateway'], default: '0.0.0.0', desc: '게이트웨이가 듣는 주소.', advanced: true },
            { key: 'GATEWAY_ALLOWED_GAME_HOSTS', services: ['gateway'], default: '127.0.0.1,localhost,::1', desc: 'heartbeat에 실린 인게임 서버 주소 중 넘겨줘도 되는 호스트.', advanced: true },
            { key: 'GATEWAY_ALLOWED_GAME_PORTS', services: ['gateway'], default: '1024-65535', desc: '넘겨줘도 되는 인게임 서버 포트 범위.', advanced: true },
            { key: 'GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS', services: ['gateway'], default: '3000', desc: '인게임 서버 연결 제한 시간(ms).', rule: positiveInt, advanced: true },
            { key: 'GATEWAY_UPSTREAM_RESPONSE_TIMEOUT_MS', services: ['gateway'], default: '10000', desc: '인게임 서버 응답 제한 시간(ms).', rule: positiveInt, advanced: true },
            { key: 'GATEWAY_REPLAY_REQUESTS_PER_MINUTE', services: ['gateway'], default: '30', desc: 'IP당 분당 리플레이 다운로드 요청 수.', rule: positiveInt, advanced: true },
        ],
    },
    {
        title: '감독자',
        note: '인게임 서버 프로세스 수를 정한다. 늘리는 기준은 줄이는 기준보다 넉넉히 커야 한다.',
        vars: [
            { key: 'SUPERVISOR_MIN_SERVERS', services: ['supervisor'], default: '1', desc: '최소 인게임 서버 수.', rule: positiveInt, advanced: true },
            { key: 'SUPERVISOR_MAX_SERVERS', services: ['supervisor'], default: '4', desc: '최대 인게임 서버 수(64 이하).', rule: positiveInt, advanced: true },
            { key: 'SUPERVISOR_SCALE_UP_LOAD', services: ['supervisor'], default: '6', desc: '서버당 평균 부하가 이보다 크면 늘린다.', advanced: true },
            { key: 'SUPERVISOR_SCALE_DOWN_LOAD', services: ['supervisor'], default: '1.5', desc: '서버당 평균 부하가 이보다 작으면 줄인다.', advanced: true },
            { key: 'SUPERVISOR_COOLDOWN_MS', services: ['supervisor'], default: '30000', desc: '한 번 늘리거나 줄인 뒤 다음까지의 최소 간격(ms).', rule: positiveInt, advanced: true },
            { key: 'SUPERVISOR_SERVER_PREFIX', services: ['supervisor'], default: 'game-auto', desc: '감독자가 띄우는 서버 id 앞부분.', advanced: true },
        ],
    },
    {
        title: 'Docker 배포 스택',
        note: '`deploy/compose.yml`만 읽는다(.env.deploy).',
        vars: [
            { key: 'COMPOSE_PROJECT_NAME', services: ['compose'], desc: 'Docker 프로젝트 이름. 볼륨 이름이 여기서 나온다. 한 번 정하면 바꾸지 않는다.', profiles: { dev: null, deploy: 'switch' } },
            {
                key: 'SWITCH_DOMAIN', services: ['compose'], desc: 'HTTPS로 열 도메인. 채우면 `npm run stack:up`이 Caddy를 함께 띄워 인증서를 자동으로 받는다. 비우면 HTTP 로컬 테스트.',
                rule: (v) => (/^[A-Za-z0-9.-]+$/.test(v) ? null : '도메인 이름만 적는다(스킴·경로 없이)'),
                profiles: { dev: null, deploy: (o) => o.domain ?? '' },
            },
            { key: 'WEB_BIND', services: ['compose'], default: '127.0.0.1', desc: 'HTTP 포트를 열 호스트 주소. 기본은 이 머신에서만 접속된다.', profiles: { dev: null, deploy: '127.0.0.1' } },
            { key: 'WEB_PORT', services: ['compose'], default: '8080', desc: 'HTTP 포트.', rule: positiveInt, profiles: { dev: null, deploy: '8080' } },
            { key: 'INTERNAL_SUBNET', services: ['compose'], default: '172.29.240.0/24', desc: '컨테이너 네트워크 대역. VPN과 겹칠 때만 바꾼다. 프록시 신뢰 범위도 이 값을 따른다.', advanced: true, profiles: { dev: null } },
        ],
    },
];

const VARS = GROUPS.flatMap((group) => group.vars.map((entry) => ({ ...entry, group: group.title })));
const BY_KEY = new Map(VARS.map((entry) => [entry.key, entry]));

module.exports = { GROUPS, VARS, BY_KEY };
