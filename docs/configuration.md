# 설정 (환경 변수)

<!-- scripts/env/schema.cjs에서 생성된다(npm run env:docs). 손으로 고치지 않는다. -->

서버 4종은 모두 환경 변수로 설정한다. 파일은 직접 쓰지 않고 생성기로 만든다.

| 명령 | 만드는 파일 | 용도 |
| --- | --- | --- |
| `npm run setup` | `.env` | 로컬 개발. 비밀값을 자동으로 채운다 |
| `npm run setup -- deploy` | `.env.deploy` | Docker 배포(`npm run stack:up`). 도메인과 메일 계정을 묻는다 |
| `npm run env:check` (`-- deploy`) | — | 서버가 기동을 거부할 값을 미리 찾는다. 값은 화면에 찍지 않는다 |

이미 파일이 있으면 setup은 기존 값을 바꾸지 않고, 새로 생긴 필수 항목만 덧붙인다. 처음부터 다시
만들려면 `--force`(기존 파일은 `.bak`으로 남긴다). 암호화 키를 바꾸면 기존 DB의 암호화 데이터와
세션을 쓸 수 없게 되므로 운영 파일에는 쓰지 않는다.

게임 밸런스 값은 환경 변수가 아니라 코드에 있다(BASE.md §0의 표: `shared/src/protocol/tuning.ts`,
`server-game/src/config/gameplay.ts`, `server-game/src/config/network.ts`). 클라이언트 빌드 설정은
`client/.env.example`을 본다.

읽는 곳: match = 매칭 서버, game = 인게임 서버, gateway = 게이트웨이, supervisor = 감독자,
compose = Docker Compose 파일. **굵게** 표시한 것은 필수, (prod)는 `APP_ENV=prod`일 때만 필수다.

## 기본

| 변수 | 읽는 곳 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `APP_ENV` | match, game, gateway, supervisor | `dev` | dev \| staging \| prod. Redis 키 앞에 붙어 환경을 나눈다. prod는 쿠키를 Secure로 만들고, 메일 sink·완화된 속도 제한·무서명 리플레이로는 기동하지 않는다. |
| `BUILD_ID` | match, game | `dev` | 경기 결과와 리플레이에 찍히는 빌드 이름. 배포할 때마다 바꾼다(예: 커밋 SHA). |

## PostgreSQL

| 변수 | 읽는 곳 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `DB_HOST` | match | `localhost` | DB 주소. Docker 배포에서는 compose가 postgres로 덮어쓴다. |
| `DB_PORT` | match, compose | `5432` | DB 포트. 로컬 개발에서는 docker-compose.yml이 이 포트로 연다. |
| **`DB_USER`** | match, compose |  | DB 사용자. |
| **`DB_PASSWORD`** | match, compose | 자동 생성 | DB 비밀번호. |
| **`DB_NAME`** | match, compose |  | DB 이름. |
| `DB_SSL` | match | `false` | true면 TLS로 붙고 인증서와 호스트 이름을 검증한다(관리형 DB용). |

## Redis

| 변수 | 읽는 곳 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `REDIS_HOST` | match, game, gateway, supervisor | `localhost` | Redis 주소. Docker 배포에서는 compose가 redis로 덮어쓴다. |
| `REDIS_PORT` | match, game, gateway, supervisor, compose | `6379` | Redis 포트. |
| **`REDIS_PASSWORD`** | match, game, gateway, supervisor, compose | 자동 생성 | 비밀번호 없이 뜬 Redis는 같은 네트워크의 누구나 방 배정과 전적을 조작할 수 있다. |

## 인증 비밀값

| 변수 | 읽는 곳 | 기본값 | 설명 |
| --- | --- | --- | --- |
| **`JWT_ACCESS_SECRET`** | match | 자동 생성 | access token 서명 키. 세 JWT 키는 32자 이상이고 서로 달라야 한다. |
| **`JWT_REFRESH_SECRET`** | match | 자동 생성 | refresh token과 쿠키 서명 키. |
| **`JWT_GUEST_REFRESH_SECRET`** | match | 자동 생성 | 게스트 refresh token 서명 키. 계정 키와 달라야 게스트 토큰이 새어도 계정으로 넘어가지 못한다. |
| `JWT_ACCESS_EXPIRATION` | match | `900` | access token 수명(초). |
| `JWT_REFRESH_EXPIRATION` | match | `1209600` | refresh token 수명(초). |
| `JWT_GUEST_EXPIRATION` | match | `900` | 게스트 access token 수명(초). |
| `JWT_GUEST_REFRESH_EXPIRATION` | match | `3600` | 게스트 refresh token 수명(초). |
| **`SESSION_IP_HMAC_SECRET`** | match | 자동 생성 | 세션·감사 로그의 IP를 장기 보관용 HMAC으로 바꾸는 키(32바이트 이상). |
| **`SESSION_IP_ENCRYPTION_KEY`** | match | 자동 생성 | 짧게 보관하는 원본 IP를 암호화하는 AES-256-GCM 키. |
| **`MFA_TOTP_ENCRYPTION_KEY`** | match | 자동 생성 | OTP 비밀값을 암호화하는 AES-256-GCM 키. SESSION_IP_ENCRYPTION_KEY와 달라야 한다. |
| `MFA_TOTP_ENCRYPTION_KEY_PREVIOUS` | match |  | 키를 회전하는 동안만 직전 키를 넣는다. 검증에 성공하면 현재 키로 다시 암호화된다. |
| `MFA_TRUSTED_DEVICE_DAYS` | match | `30` | 신뢰 기기 등록 기간(일). 1~90. |

## 메일

| 변수 | 읽는 곳 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `EMAIL_TRANSPORT` | match | `sink` | sink는 메일을 보내지 않고 Redis `test:mail:{용도}:{email}`에 코드를 남긴다(로컬·e2e). 실제 사용자가 가입하려면 smtp. |
| `SMTP_USER` | match |  | SMTP 계정. SMTP_PASSWORD와 함께 넣는다. |
| `SMTP_PASSWORD` | match | 자동 생성 | SMTP 비밀번호(Gmail은 앱 비밀번호). |
| `SMTP_HOST` | match | `smtp.gmail.com` | SMTP 서버. |
| `SMTP_PORT` | match | `465` | SMTP 포트. |
| `SMTP_SECURE` | match | `true` | true면 처음부터 TLS(465), false면 STARTTLS(587). |
| `SMTP_FROM` | match | `SMTP_USER` | 보내는 사람 주소. |

## 리플레이

| 변수 | 읽는 곳 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `REPLAY_ENABLED` | game | `false` | 경기를 리플레이 파일로 기록한다. |
| `REPLAY_STORE` | game | `local` | 저장소. 지금은 local(디스크)만 구현돼 있다. |
| `REPLAY_LOCAL_DIR` | game | `./replays` | 리플레이와 결과 저널(.result-outbox)을 쓰는 폴더. 실행 스크립트와 Docker 이미지가 알맞게 채운다. |
| `REPLAY_SIGNING_KEY` (prod) | game | 자동 생성 | 리플레이 서명 개인키(PKCS#8 PEM을 base64로 한 줄). 인게임 서버만 가진다. 비우면 개발용 무서명 파일을 만든다. |
| `REPLAY_SIGNING_KEY_ID` (prod) | game | 자동 생성 | 서명 키 이름(16바이트 이하). 파일에 함께 찍힌다. |
| `REPLAY_SIGNING_PUBLIC_KEYS` | match | 자동 생성 | 재생기가 서명을 확인할 공개키 목록 `keyId:base64,...`. 키를 바꾸는 동안 옛 키도 남겨 두면 예전 파일도 검증된다. |

## 인게임 서버

| 변수 | 읽는 곳 | 기본값 | 설명 |
| --- | --- | --- | --- |
| **`GAME_ALLOWED_ORIGINS`** | game |  | WebSocket을 허용할 브라우저 주소(스킴://호스트[:포트]) 목록. 비어 있으면 인게임 서버가 기동하지 않는다. |
| `GAME_MAX_ROOMS` | game | `100` | 프로세스 하나가 들 방의 상한. 측정값이 아니라 보수적인 출발점이다. |
| `GAME_HOST` | game | `0.0.0.0` | 인게임 서버가 듣는 주소. |
| `GAME_INTERNAL_HOST` | game | `127.0.0.1` | 게이트웨이가 인게임 서버에 닿을 주소. heartbeat에 실린다. |
| `GAME_TRUSTED_PROXIES` | game |  | 클라이언트 IP 헤더를 믿을 프록시 주소(쉼표, CIDR 가능). 게이트웨이와 그 앞 프록시를 전부 적는다. Docker 배포는 compose가 채운다. |
| `GAME_SERVER_ID` | game |  | 프로세스 고유 id. 감독자가 띄울 때와 `npm run game:start`가 알아서 정한다. |
| `GAME_PUBLIC_WS_PATH` | game | `/game-ws/{GAME_SERVER_ID}` | 반드시 `/game-ws/{GAME_SERVER_ID}`. 실행 스크립트가 맞춰 준다. |
| `GAME_PORT` | game | `4000` | `game:start`의 포트. 감독자가 띄우는 서버는 빈 포트를 고른다. |
| `GAME_MAP_BUNDLE` | game | `server-game/maps/server_maps.json` | 맵 번들 경로. 실행 스크립트와 Docker 이미지가 채운다. 직접 실행할 때는 절대 경로. |
| `GAME_ALLOW_DUPLICATE_SERVER_ID` | game | `false` | 비상용. 같은 id의 heartbeat가 살아 있어도 기동한다. |

## 매칭 서버

| 변수 | 읽는 곳 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `PORT` | match | `3000` | 매칭 서버 포트. |
| `MATCH_TRUSTED_PROXIES` | match |  | X-Forwarded-For를 믿을 프록시 주소(쉼표, CIDR 가능). 리버스 프록시 뒤에서 비우면 모든 요청이 한 IP로 보여 IP 제한이 전역이 된다. Docker 배포는 compose가 채운다. |
| `MATCH_SERVER_ID` | match | `match-{임의}` | 운영 화면의 요청 집계에 쓰는 인스턴스 이름. |
| `RATE_LIMIT_RELAXED` | match | `false` | true면 속도 제한 한도만 50배로 넓힌다(e2e가 한 IP에서 계정을 수십 개 만들 때). prod에서는 기동을 거부한다. |

## 보관 기간

값을 바꾸면 BASE.md §14.1과 개인정보처리방침(legal/)도 함께 고친다.

| 변수 | 읽는 곳 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `MATCH_RETENTION_DAYS` | match | `30` | 전적(경기·참가자) 보관 일수. |
| `REPLAY_RETENTION_HOURS` | match | `2` | 리플레이 보관 시간. 신고 hold가 걸린 것은 남는다. |
| `SESSION_RETENTION_DAYS` | match | `30` | 끝난 세션 행을 남기는 일수. |
| `SESSION_IP_RETENTION_DAYS` | match | `7` | 세션의 암호화 원본 IP 보관 일수. |
| `AUDIT_LOG_RETENTION_DAYS` | match | `365` | 감사 로그 보관 일수. |
| `AUDIT_IP_RETENTION_DAYS` | match | `7` | 감사 로그의 암호화 원본 IP 보관 일수. |
| `MODERATION_CASE_RETENTION_DAYS` | match | `1825` | 종결된 신고 사건 보관 일수. |
| `SANCTION_RETENTION_DAYS` | match | `1825` | 경고·끝난 제재 기록 보관 일수. 영구 정지는 남는다. |
| `AUTH_SECURITY_EVENT_RETENTION_DAYS` | match | `365` | refresh 재사용 같은 인증 보안 사건 보관 일수. |
| `RETENTION_INTERVAL_MINUTES` | match | `10` | 정리 작업 간격(분). 첫 회차는 기동 1분 뒤. |

## 게이트웨이

| 변수 | 읽는 곳 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `GATEWAY_PORT` | gateway | `4100` | 게이트웨이 포트. |
| `GATEWAY_HOST` | gateway | `0.0.0.0` | 게이트웨이가 듣는 주소. |
| `GATEWAY_ALLOWED_GAME_HOSTS` | gateway | `127.0.0.1,localhost,::1` | heartbeat에 실린 인게임 서버 주소 중 넘겨줘도 되는 호스트. |
| `GATEWAY_ALLOWED_GAME_PORTS` | gateway | `1024-65535` | 넘겨줘도 되는 인게임 서버 포트 범위. |
| `GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS` | gateway | `3000` | 인게임 서버 연결 제한 시간(ms). |
| `GATEWAY_UPSTREAM_RESPONSE_TIMEOUT_MS` | gateway | `10000` | 인게임 서버 응답 제한 시간(ms). |
| `GATEWAY_REPLAY_REQUESTS_PER_MINUTE` | gateway | `30` | IP당 분당 리플레이 다운로드 요청 수. |

## 감독자

인게임 서버 프로세스 수를 정한다. 늘리는 기준은 줄이는 기준보다 넉넉히 커야 한다.

| 변수 | 읽는 곳 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `SUPERVISOR_MIN_SERVERS` | supervisor | `1` | 최소 인게임 서버 수. |
| `SUPERVISOR_MAX_SERVERS` | supervisor | `4` | 최대 인게임 서버 수(64 이하). |
| `SUPERVISOR_SCALE_UP_LOAD` | supervisor | `6` | 서버당 평균 부하가 이보다 크면 늘린다. |
| `SUPERVISOR_SCALE_DOWN_LOAD` | supervisor | `1.5` | 서버당 평균 부하가 이보다 작으면 줄인다. |
| `SUPERVISOR_COOLDOWN_MS` | supervisor | `30000` | 한 번 늘리거나 줄인 뒤 다음까지의 최소 간격(ms). |
| `SUPERVISOR_SERVER_PREFIX` | supervisor | `game-auto` | 감독자가 띄우는 서버 id 앞부분. |

## Docker 배포 스택

`deploy/compose.yml`만 읽는다(.env.deploy).

| 변수 | 읽는 곳 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | compose |  | Docker 프로젝트 이름. 볼륨 이름이 여기서 나온다. 한 번 정하면 바꾸지 않는다. |
| `SWITCH_DOMAIN` | compose |  | HTTPS로 열 도메인. 채우면 `npm run stack:up`이 Caddy를 함께 띄워 인증서를 자동으로 받는다. 비우면 HTTP 로컬 테스트. |
| `WEB_BIND` | compose | `127.0.0.1` | HTTP 포트를 열 호스트 주소. 기본은 이 머신에서만 접속된다. |
| `WEB_PORT` | compose | `8080` | HTTP 포트. |
| `INTERNAL_SUBNET` | compose | `172.29.240.0/24` | 컨테이너 네트워크 대역. VPN과 겹칠 때만 바꾼다. 프록시 신뢰 범위도 이 값을 따른다. |
