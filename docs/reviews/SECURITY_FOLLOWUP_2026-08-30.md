# swITch 추가 보안 감사 — 레이트리밋·악성 입력·서버 간 통신

검토일: 2026-08-30  
상태: **발견 사항 정리만 완료. 이 문서의 미조치 항목은 아직 코드에 반영하지 않았다.**  
검토 범위: `server-match`, `server-game`, `server-gateway`, `server-supervisor`, `shared`, 리플레이 클라이언트

이번 검토에서는 실제 `.env`와 `.env.backup-*`의 내용을 읽거나 출력하지 않았다. 파일이 Git에서
제외되는지와 과거 추적 이력만 확인했다. 현재 Docker Compose의 PostgreSQL과 Redis는 호스트
`127.0.0.1`에만 바인딩되고 Redis 비밀번호도 필수라서, **이 노트북에서만 돌리는 기본 구성**은
외부 네트워크 노출이 상당히 줄어든다. 아래 서버 간 통신 항목의 일부는 여러 호스트로 분리 배포할
때 심각도가 크게 올라간다.

## 심각도 기준

| 등급 | 기준 |
|---|---|
| **치명적 (P0)** | 세션 탈취·지속적인 계정 장악처럼 즉시 막아야 하는 경로 |
| **높음 (P1)** | 인증 우회, 실질적인 무제한 시도, 중앙 서비스 중단, 전적/권한 무결성 훼손 |
| **중간 (P2)** | 추가 조건이 필요하거나 피해가 시간·한 프로세스·한 화면으로 제한됨 |
| **낮음 (P3)** | 현재 직접 악용 경로는 약하지만 다음 변경에서 취약점이 되기 쉬운 방어 누락 |

## 한눈에 보는 결론

| ID | 심각도 | 발견 사항 | 주된 영향 |
|---|---|---|---|
| C-01 | **치명적** | 이미 쓴 refresh 토큰을 10초 유예가 다시 최신 세션으로 연결 | 세션 탈취 유지, 정상 사용자 강제 로그아웃 |
| H-01 | **높음** | HTTP 제한 키가 IP에서 게스트/계정 ID로 **교체**됨 | 게스트 ID 수만큼 로그인·메일 제한 증식 |
| H-02 | **높음** | HTTP 제한 저장소가 프로세스 메모리이고 로그인 대상별 제한이 없음 | 서버 수·재시작·분산 IP에 따라 무차별 대입 한도 증식 |
| H-03 | **높음** | 인증 메일에 수신 주소별 cooldown이 없고 새 코드가 옛 코드를 덮음 | 피해자 코드 무효화, 메일 폭탄, 복구 방해 |
| H-04 | **높음** | 모든 서버가 Redis 전체 권한 하나를 공유하고 메시지 인증/TLS가 없음 | 한 프로세스 침해가 인증·제어·전적 전체로 확산 |
| H-05 | **높음** | 비밀번호 재설정과 세션 폐기가 원자적이지 않고 로그인 경합을 못 막음 | 복구 뒤에도 공격자 세션/옛 비밀번호 로그인이 살아남음 |
| H-06 | **높음(내부 침해 조건)** | 매칭 서버가 발급하지 않은 재경기 matchId도 계속 결과로 승인 가능 | 전적·XP를 임의로 반복 적립 |
| M-01 | **중간** | 잘못된 Bearer 토큰은 레이트리밋보다 먼저 401 | JWT 검증 비용을 제한 없이 유발 |
| M-02 | **중간** | 존재하지 않는 이메일 로그인은 bcrypt를 생략 | 응답 시간으로 가입 이메일 추정 |
| M-03 | **중간** | 폐기·밴·비밀번호 변경 뒤 account access token이 최대 15분 유효 | 일부 계정 API의 즉시 차단 실패 |
| M-04 | **중간** | 인증 코드는 검증과 소비가 원자적이지 않음 | 같은 코드를 동시 요청 두 개가 함께 통과 |
| M-05 | **중간** | WS는 인증 후 IP 집계 한도 없이 connection/user만 제한 | 한 IP의 다수 게스트가 2,000개 전역 슬롯 고갈 가능 |
| M-06 | **중간** | WS 이벤트의 async 오류 경계가 없음 | 입력 처리 예외가 프로세스 종료로 번질 수 있음 |
| M-07 | **중간** | 리플레이 다운로드의 틀린 ticket 요청은 무제한 Redis GET | 공개 요청으로 Redis/게임 서버 부하 증폭 |
| M-08 | **중간** | 로컬 리플레이 파일 크기와 gzip 실제 출력 크기 제한이 늦음 | 압축 폭탄·대용량 파일로 브라우저 탭 메모리 고갈 |
| M-09 | **중간** | 게이트웨이 heartbeat 주소 검증, 메서드 제한, upstream timeout이 부족 | 잘못된 주소로 crash/제한적 SSRF, 연결 고갈 |
| M-10 | **중간** | 매칭 Fastify의 요청 timeout이 0이고 본문 상한이 기본 1 MiB | 느린 본문·불필요하게 큰 JSON으로 연결/메모리 점유 |
| M-11 | **중간** | 이메일을 trim/lowercase하지 않고 DB도 대소문자를 구분 | 중복 계정·복구 대상 혼동 |
| L-01 | **낮음** | ValidationPipe whitelist와 일부 문자열 길이 제한이 없음 | 미래 mass-assignment 및 저장 공간 오용 위험 |

우선순위는 **C-01 → H-01/H-02/H-03 → H-05 → H-04/H-06 → M 계열** 순서가 적절하다.

## 상세 발견 사항

### C-01. refresh 회전 유예가 탈취된 옛 토큰을 되살린다 — 치명적

근거: `server-match/src/auth/auth.service.ts`의 `REFRESH_ROTATION_GRACE_MS`, `refresh()`와
`server-match/src/auth/refresh-rotation.spec.ts`의 “유예 내 옛 토큰 경합 회전” 테스트.

현재 흐름은 다음과 같다.

1. 정상 사용자가 `T0/S0`를 refresh해 `T1/S1`을 받는다. `S0 → S1` 표가 Redis에서 10초 산다.
2. `T0`를 가진 공격자가 10초 안에 다시 보낸다.
3. 서버는 `T0`가 이미 폐기됐음을 알면서도 `S1`을 찾아 **S1을 폐기하고 `T2/S2`를 공격자에게 준다.**
4. 처리 뒤 `S0 → S2` 표의 TTL도 다시 10초로 갱신한다.

따라서 공격자는 옛 `T0`를 10초보다 짧은 간격으로 반복해 최신 세션을 계속 빼앗고 정상 사용자의
refresh 토큰을 계속 폐기할 수 있다. 원래 `S0`의 만료 시각까지 이 동작을 이어갈 수 있다. 정상
탭 경합을 완화하려던 코드가 refresh 재사용 탐지를 반대로 무력화한 상태다.

권장 조치:

- 가장 안전한 즉시 조치는 **폐기된 refresh 토큰을 무조건 재사용 공격으로 처리**하고 세션 family를
  폐기하는 것이다.
- 탭 경합은 클라이언트 `BroadcastChannel`/Web Locks로 막거나, 서버가 첫 회전 결과의 **동일한
  successor 응답**을 짧게 암호화 보관해 재전송해야 한다. 옛 토큰으로 successor를 다시 회전해서는
  안 된다.
- 회전 family id와 세대 번호를 두고 재사용 이벤트를 감사 로그에 남긴다.

### H-01. 인증을 붙이면 IP 제한이 사라지고 신원별 제한으로 갈아탄다 — 높음

근거: `server-match/src/ratelimiter.guard.ts`의 `getTracker()`.

익명 요청은 `ip:{주소}`로 세지만 Bearer 토큰이 있으면 `guest:{id}` 또는 `account:{id}`만 센다.
두 기준을 함께 적용하는 것이 아니라 IP 기준을 버린다. `/auth/login`, `/auth/verify`,
`/auth/password/reset`, `/users/register`도 같은 가드를 쓴다.

공격자는 `/auth/guest`를 호출할 때만 Authorization을 빼서 익명 발급 한도를 쓰고, 얻은 여러 게스트
토큰을 로그인·메일 요청에 번갈아 붙일 수 있다. access token 15분과 sliding guest refresh 1시간을
이용하면 게스트 신원을 장기간 계속 쌓아 둘 수 있다. 결과적으로 표시된 “분당 5회”는 실제로
“게스트 신원당 분당 5회”가 된다.

권장 조치: 인증 관련 경로는 Redis에서 **IP + actor + target** 세 버킷을 모두 검사한다. NAT를
고려해 IP 한도는 actor 한도보다 넓게 두되, actor가 생겼다고 IP 버킷을 제거하지 않는다.

### H-02. HTTP 제한이 인스턴스별 메모리이고 로그인 대상별 제한이 없다 — 높음

근거: `server-match/src/app.module.ts`는 별도 `ThrottlerStorage`를 주입하지 않는다. 현재 설치된
`@nestjs/throttler`의 기본 `ThrottlerStorageService`는 프로세스 안 `Map`과 timer를 쓴다.

- 매칭 서버가 N대면 실효 한도도 거의 N배다.
- 프로세스를 재시작하면 카운터가 즉시 사라진다.
- 같은 이메일을 여러 IP/게스트 ID에서 공격하는 **대상 계정별 실패 버킷**이 없다.
- bcrypt가 있는 로그인 경로는 공격자 트래픽이 CPU 고갈로 바로 이어진다.

방 생성/참가는 `RoomsService.enforceActorRate()`와 게스트 IP Redis 버킷이 한 겹 더 있어 상대적으로
안전하다. 같은 방식의 Redis 원자 카운터를 인증 경로에도 적용하는 것이 맞다. 로그인 성공 시에도
IP 버킷을 바로 지우지 말고, 대상 이메일 버킷만 정책에 따라 완화한다.

### H-03. 한 주소로 인증 메일을 반복 발급해 정상 코드를 무효화할 수 있다 — 높음

근거: `AuthService.sendVerificationCodeEmail()`과 `issueVerificationCode()`.

발급은 `purpose + email` 키에 새 값을 `SET`하므로 이전 코드를 즉시 덮는다. 수신 주소별 발급
cooldown은 없고 H-01의 게스트 신원 증식도 적용된다. 공격자는 피해자가 받은 정상 재설정 코드를
계속 무효화하면서 메일함을 채울 수 있다.

권장 조치: 정규화한 `purpose + email` 기준 Redis cooldown/분·시간 한도를 두고, 일정 시간 안의
재요청에는 기존 코드의 수명을 유지하거나 발송 자체를 생략한다. IP·actor 한도도 함께 적용한다.

### H-04. 서버 간 신뢰가 Redis 비밀번호 하나에 집중되어 있다 — 높음

근거: 매칭·게임·게이트웨이·감독자가 모두 `REDIS_PASSWORD` 하나로 연결하며 username/ACL/TLS
옵션이 없다. control command/reply, heartbeat, 결과 stream에는 HMAC이나 서명이 없다.

게임 서버 하나가 침해되면 같은 credential로 다음이 가능하다.

- 인증 코드와 guest/replay ticket 키 읽기·변조
- 다른 서버 heartbeat 위조 및 게이트웨이 목적지 변경
- 방 생성/강퇴/drain/삭제 명령과 reply 위조
- 결과 stream에 임의 전적 삽입
- 매칭 서버의 일회성 응답 stream 방해

현재 Compose가 Redis를 루프백에 묶은 것은 **외부 접속**을 막지만, 한 프로세스가 침해됐을 때의
수평 이동은 막지 못한다. Redis나 PostgreSQL을 다른 호스트로 옮기면 현재 설정은 TLS도 제공하지
않아 내부망 도청·MITM 위험까지 생긴다. 게이트웨이↔게임 서버도 평문 HTTP/TCP다.

권장 조치:

- Redis ACL 사용자를 `match`, `game`, `gateway`, `supervisor`로 나누고 명령·키 prefix를 최소화한다.
- 원격 Redis/PostgreSQL은 인증서 검증이 켜진 TLS만 허용한다.
- control/result envelope에 발신자 id, nonce/sequence, deadline과 HMAC 또는 서명을 넣는다.
- 게임 서버마다 별도 credential을 두고, 매칭 서버가 그 서버에 발급한 match/result nonce를 검증한다.

### H-05. 비밀번호 복구와 기존 세션 차단 사이에 틈이 있다 — 높음

근거: `AuthService.resetPassword()`는 사용자 해시를 먼저 커밋한 뒤 별도 호출로
`SessionService.revokeAll()`을 실행한다.

- 해시 갱신 뒤 세션 폐기가 실패하면 새 비밀번호만 반영되고 공격자 세션은 남는다.
- 인증 코드는 이미 폐기됐으므로 사용자는 같은 요청을 안전하게 재시도할 수도 없다.
- 옛 비밀번호 로그인이 bcrypt 비교를 먼저 통과한 뒤 reset/change가 커밋되면, 나중에
  `createSession()`이 사용자 행을 잠그고 **새 세션을 다시 만들 수 있다.** 잠금 시점에 비교했던
  password hash가 그대로인지 재확인하지 않기 때문이다.

권장 조치: 사용자 행 잠금, password hash 갱신, 전체 세션 폐기를 한 DB 트랜잭션으로 묶고,
로그인 세션 생성 시 처음 검증한 hash가 잠금 뒤에도 동일한지 확인한다. 복구 시 account token
version/security epoch를 올려 이미 발급된 access token도 즉시 거절하는 편이 안전하다.

### H-06. 재경기 결과가 매칭 서버 발급 없이 계속 만들어질 수 있다 — 높음(내부 침해 조건)

근거: `server-match/src/results/result.service.ts`의 `issueRematch()`.

알 수 없는 새 `matchId`가 와도 같은 room/server의 과거 match와 참가자 부분집합만 맞으면 새 match
행을 만든다. 방이 끝났는지, 이번 재경기를 매칭 서버가 승인했는지, 앞선 결과에서 딱 한 번 이어진
것인지 확인하는 nonce/세대가 없다. 게임 서버 또는 Redis writer가 침해되면 같은 참가자에게 새
UUID 결과를 반복 제출해 games/wins/XP를 계속 올릴 수 있다.

권장 조치: 매 재경기마다 matching-issued `matchId + room epoch + result nonce`를 선발급하고 한 번만
소비한다. 결과 envelope도 서버별 키로 인증하고, 방 폐기 뒤에는 result authorization을 닫는다.

## 중간 심각도 상세

### M-01. 잘못된 Bearer 토큰은 레이트리밋을 통과하지 않는다

`APP_GUARD` 순서가 `JwtAuthGuard` 다음 `RateLimiterGuard`다. 임의 Bearer 문자열은 JWT 검증에서
먼저 401이 나므로 카운터에 기록되지 않는다. 공격자는 서명 검증 비용을 제한 없이 만들 수 있다.
인증 전 IP limiter를 가장 바깥에 두거나 invalid-token 실패도 IP Redis 버킷에 기록해야 한다.

### M-02. 로그인 이메일 존재 여부가 시간으로 갈린다

`if (!user || !await bcrypt.compare(...))`는 없는 이메일에서 bcrypt를 생략한다. 응답 문구는 같지만
충분한 표본을 모으면 가입 여부를 추정할 수 있다. 없는 사용자도 고정 dummy bcrypt hash와 비교한다.

### M-03. account access token 폐기가 즉시 반영되지 않는다

계정 access JWT는 `JwtAuthGuard`에서 session DB를 확인하지 않는다. 로그아웃·밴·탈퇴·비밀번호
변경으로 refresh 세션을 지워도 일부 account API는 기본 900초 동안 옛 access token을 받는다.
관리자와 방 경로 일부는 DB 상태를 다시 봐 피해가 제한되지만, 전적/통계/신고/리플레이 ticket 등은
즉시 차단되지 않는다. 민감 경로 session check 또는 짧은 Redis security epoch가 필요하다.

### M-04. 인증 코드 검증과 소비가 분리되어 있다

`verifyVerificationCode()`는 맞는 코드를 그대로 남기고 비즈니스 작업 뒤
`discardVerificationCode()`가 지운다. 동시에 들어온 두 요청이 모두 검증을 통과할 수 있다.
실패 시 재사용성을 유지하려면 단순 `GETDEL` 대신 짧은 claim/lease CAS를 사용하고, 작업 성공 시
확정 소비하고 실패 시 claim만 돌려놓는다.

### M-05. 인증된 WebSocket의 IP 집계 상한이 없다

`RATE_LIMIT_SCOPES`는 의도적으로 `connection`, `user`만 사용한다. `ConnectionManager`도 IP당
**미인증** 연결 15개만 세고 인증 후에는 그 수를 내린다. 많은 guest ID를 가진 한 IP가 인증을
순차 완료하면 전역 `MAX_CONNECTIONS=2000` 대부분을 차지할 수 있다. NAT 여유가 있는 인증 연결
상한과 IP aggregate packet budget을 별도로 둔다.

### M-06. WS 사용자 이벤트의 최종 예외 경계가 없다

`socket.on('message')`에서 `void (async () => { ... })()`를 호출하지만 `.catch()`가 없다.
`authenticate()` 또는 이후 handler가 throw하면 unhandled rejection이 되고 Node 설정에 따라
프로세스가 종료될 수 있다. `close`의 `onDisconnect`도 최종 try/catch가 없다. 알려진 crash packet은
찾지 못했지만, 사용자 입력 경로의 한 논리 오류가 프로세스 전체 장애가 되는 구조다.

### M-07. 리플레이의 틀린 ticket도 중앙 Redis를 두드린다

`/replays/*?ticket=...`은 별도 rate limit 없이 임의 문자열마다 게임 서버에서 Redis `GET`을 한다.
ticket 엔트로피는 충분해 brute-force 성공 가능성은 없지만, 공개 HTTP flood가 중앙 Redis 부하로
증폭된다. ticket 형식/길이를 먼저 검사하고 게이트웨이와 게임 서버 양쪽에 IP limiter를 둔다.
유효 요청도 파일 전체를 `readFile`한 뒤 메모리에서 응답하므로 동시 다운로드 상한이나 streaming이
필요하다.

### M-08. 사용자 제공 리플레이 파일의 메모리 상한이 늦다

`ReplayPage`는 `file.arrayBuffer()` 전에 `file.size`를 검사하지 않는다. `decodeChunk()`는 선언된
`rawLen`을 16 MiB로 제한하지만 `codec.gunzip()`이 **전부 압축 해제한 뒤** 실제 길이를 비교한다.
즉 gzip bomb은 검사 전에 메모리를 이미 소비한다. 브라우저 stream collector가 상한을 넘는 순간
cancel해야 하고, codec API에 `maxOutputBytes`를 넘겨야 한다. 파일 전체 크기·chunk 총 rawLen·manifest
필드도 함께 제한/검증한다.

### M-09. 게이트웨이가 heartbeat를 네트워크 주소로 바로 신뢰한다

`RegistryView`는 JSON과 `serverId === id`만 확인한다. `internalAddress`의 scheme/host/port, 숫자
부하값, 갱신 시각을 검증하지 않는다. 요청 handler의 `new URL(backend.address)`도 try/catch 밖이라
잘못된 heartbeat 하나가 다음 공개 요청에서 gateway를 종료시킬 수 있다. Redis writer는 제한된
`/map-bundles`·`/replays`·`/game-ws` 경로이기는 해도 임의 내부 host로 요청을 보낼 수 있다.

또한 게이트웨이는 map/replay 경로의 임의 HTTP method와 body를 upstream으로 pipe하고, upstream
응답 timeout과 자체 요청 rate limit이 없다. GET/HEAD만 받고 body를 거절하며, 주소 allowlist와
connect/response timeout을 둔다. control reply의 `wsPath`도 상대 URL을 허용하지 말고 정확한
origin-form `/game-ws/{serverId}`만 받아야 한다.

### M-10. 매칭 HTTP 서버의 자원 상한이 운영 의도보다 느슨하다

Fastify 현재 기본값은 `bodyLimit=1,048,576`, `requestTimeout=0`, `connectionTimeout=0`이다.
이 API의 정상 JSON은 수백 바이트라 1 MiB가 필요 없고, 서버를 0.0.0.0에 직접 노출하면 느린 본문이
연결을 오래 차지한다. adapter에 약 64 KiB 본문 상한과 20~30초 요청/연결 timeout을 명시하고,
리버스 프록시에도 더 바깥 한도를 둔다.

### M-11. 이메일 canonicalization이 없다

DTO와 service가 email을 trim/lowercase하지 않고 PostgreSQL unique도 일반 `varchar`라 대소문자를
구분한다. `User@example.com`과 `user@example.com`이 별도 계정·별도 인증 코드 키가 될 수 있다.
입력 정규화만 추가하면 기존 중복과 충돌할 수 있으므로 데이터 조사 후 `lower(email)` unique index
또는 `citext` migration과 함께 적용한다.

## 낮음 및 방어 강화

- `ValidationPipe({ transform: true })`에 `whitelist`, `forbidNonWhitelisted`가 없다. 현재 service는
  대부분 필요한 필드만 꺼내 써 즉시 mass-assignment는 없지만 미래의 객체 spread 변경에 취약하다.
- `/auth/guest/refresh`는 DTO가 아니며 token 길이 상한이 없다. Fastify 본문 상한이 최종 방어다.
- `UpdateReportStatusDto.note`에 길이 상한이 없고 관리자 `q`가 반복 query array이면 `.trim()`에서
  500이 날 수 있다. 관리자 전용이지만 명시적으로 제한하는 편이 낫다.
- 리플레이 manifest는 JSON 크기만 확인하고 필드의 runtime schema를 검증하지 않는다. React XSS는
  escape되지만 malformed array/type이 리플레이 화면을 깨뜨릴 수 있다.
- account refresh JWT 자체와 refresh cookie 서명에 같은 secret을 재사용한다. 즉시 취약점은 아니며
  cookie가 JWT라 이중 서명 실익도 작다. 유지하려면 cookie 전용 secret을 분리한다.
- `/health`는 DB/Redis 연결 여부와 무관하게 `status: ok`를 반환한다. 장애 중인 인스턴스가 load
  balancer에서 계속 트래픽을 받을 수 있으므로 readiness와 liveness를 분리한다.

## 재검토에서 방어가 확인된 부분

- `MATCH_TRUSTED_PROXIES`와 `GAME_TRUSTED_PROXIES`는 임의 `X-Forwarded-For`를 신뢰하지 않는다.
- 방 생성/참가는 HTTP limiter 외에 Redis actor/guest-IP limiter도 있어 다중 인스턴스에 견딘다.
- 틀린 인증 코드는 코드 자체 기준 5회에서 폐기되고 비교는 상수 시간이다.
- WS Origin은 정확히 비교되고 query가 있는 upgrade, 큰 frame, backpressure가 차단된다.
- game seat ticket과 replay ticket은 충분한 엔트로피, 짧은 TTL, 일회성 소비를 사용한다.
- replay storage key는 정규식으로 제한되어 파일 경로 탈출을 막는다.
- SQL은 Drizzle/postgres.js parameter binding을 일관되게 사용한다.
- account access/account refresh/guest refresh 서명 키는 서로 다르고 운영의 sink mail/rate relaxed 설정은
  부팅 단계에서 거절된다.
- `.env`와 `.env.backup-*`은 `.gitignore`에 걸리고 Git 추적 이력이 확인되지 않았다.

## 권장 수정 순서와 완료 조건

1. **P0 차단:** stale refresh의 successor 회전을 제거하고 재사용 시 family 폐기 테스트를 추가한다.
2. **인증 limiter 재설계:** Redis 기반 IP+actor+target 다중 버킷, recipient cooldown, invalid-token
   pre-auth bucket을 추가한다. 두 매칭 인스턴스로 같은 총 한도가 유지되는 통합 테스트가 완료 조건이다.
3. **비밀번호 security epoch:** reset/update/session revoke 원자화와 in-flight old-password login 거절을
   경쟁 테스트로 고정한다.
4. **서버 trust 분리:** Redis ACL/TLS, heartbeat/control/result runtime schema, 주소 allowlist와
   result nonce를 적용한다.
5. **공개 자원 상한:** WS authenticated-IP, replay ticket miss, gateway method/upstream timeout,
   Fastify body/request timeout을 적용하고 저비용 부하 테스트로 429/연결 회수를 확인한다.
6. **로컬 파일 방어:** replay file/gzip 출력/총 raw 크기 상한을 브라우저 테스트로 검증한다.

전체 클러스터를 실제 secret-bearing `.env`로 띄우지 않아도 위 핵심 문제들은 순수 단위·통합 테스트로
재현할 수 있다. 부하 수치는 노트북 성능에 따라 흔들리므로 “초당 몇 요청”보다 **설정한 한도 뒤에
정확히 429/close가 나오고, 여러 인스턴스에서도 총량이 늘지 않는지**를 완료 기준으로 삼는 것이 좋다.

## 이번 회차 검증 결과

- `server-match`: 92 통과, 1 skip(DB 통합 테스트). 현재 테스트가 C-01의 “유예 내 옛 토큰도 새
  refresh를 받는다”는 동작을 명시적으로 통과시키고 있어, 발견 근거를 다시 확인했다.
- `server-gateway`: 11/11 통과.
- `client`: 92/92 통과.
- `server-game`: 전체 병렬 실행에서 WS fake-clock 타이밍 테스트 1개가 한 번 실패한 뒤 대기했고
  중단했다. 같은 테스트 단독 실행과 `ws-transport.test` 전체 독립 실행은 각각 통과(12/12)했다.
  노트북 부하에 따라 fake clock을 넘기는 시점과 소켓 queue 처리가 엇갈리는 테스트 flake로 보이며,
  알려진 crash packet이나 제품 동작 실패를 재현한 것은 아니다.
- `git diff --check`와 `.env*` ignore/추적 이력을 확인했다. 실제 환경 파일 내용은 읽지 않았다.
