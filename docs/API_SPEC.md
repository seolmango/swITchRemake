# swITch REST API 명세 (server-match)

매치 서버(NestJS/Fastify)가 제공하는 HTTP REST 엔드포인트. 인게임 실시간 통신은 `WS_PROTOCOL.md` 참고. 설계 배경은 `ARCHITECTURE.md`.

## 공통

- **Base**: `/` (기본 포트 3000)
- **인증**: 보호된 엔드포인트는 `Authorization: Bearer <accessToken>` 필요. access 수명 **15분**. refresh는 httpOnly·signed 쿠키(`refreshToken`)로 자동 송수신.
- **비로그인 접근**: 로그인이 필요 없는 엔드포인트는 게스트도 호출 가능(회원가입·매치메이킹 등).
- **에러 형식**: NestJS 기본 `{ statusCode, message, error }`. 상태코드로 구분(400 검증실패, 401 인증실패, 403 권한, 409 중복, 429 레이트리밋).
- **레이트리밋**: 익명/로그인 구분(`RateLimiterGuard`). 저장소는 **Redis 공유**(다중 인스턴스 대비).
- **전송 보안**: 프로덕션 HTTPS 필수. CORS 허용 오리진·쿠키 sameSite 정책 → `ARCHITECTURE.md` §4 "전송 보안·개인정보".

### 입력 검증 규칙 (공용, `shared`와 일치)

| 항목 | 규칙 |
|---|---|
| email | 이메일 형식, ≤254자 |
| password | 8~20자, `[A-Za-z0-9!@#$%^&*]` |
| nickname | 2~12자, `[A-Za-z0-9가-힣]` (게스트도 동일 형식, 단 유일성 미검사) |
| 인증코드 | 6자리 숫자 |
| 방 이름 | 1~16자 |
| 방 비밀번호 | 1~8자 (선택) |
| 방 코드 | 6자리 영숫자 (서버 발급, 공유용) |

---

## 인증 · 계정

### `POST /auth/verify` — 인증코드 발송
- Body: `{ email?, vtype }` — `vtype`: `signup` | `change-password` | `reset-password` | `delete`
- 로그인 필요 타입(change-password, delete)은 토큰의 userId로 이메일 확인(body email 무시). reset-password는 가입 여부와 무관하게 성공 응답(열거 방지).
- Res: `{ message, expiresAt }` (코드는 Redis에 TTL 5분)

### `POST /users/register` — 회원가입
- Body: `{ email, password, nickname, code }`
- Res: `201 { nickname }` · 409(이메일/닉네임 중복, `constraint_name`으로 구분)

### `POST /auth/login` — 로그인
- Body: `{ email, password }`
- 처리: 세션 생성(기기 1개) → `sessions` insert + `login_history` 기록. refresh 쿠키 설정.
- Res: `{ accessToken, expiresAt, user: { id, nickname } }`

### `POST /auth/refresh` — 토큰 재발급
- Cookie: `refreshToken`
- 처리: 세션 조회 → 토큰 회전(같은 sid) → `last_used_at` 갱신. 새 refresh 쿠키.
- **재사용 감지**: 회전되어 폐기된 옛 토큰이 제시되면 도난 신호 — 해당 세션 즉시 폐기 + `login_history` 보안 이벤트 기록.
- Res: `{ accessToken, expiresAt }` · 401(무효/만료/폐기 세션)

### `POST /auth/logout` — 로그아웃(이 기기) 🔒
- Cookie + Bearer. 현재 세션 삭제 + 쿠키 제거 + 감사기록.
- Res: `{ message }`

### `POST /auth/logout-all` — 전체 로그아웃 🔒
- 유저의 모든 세션 삭제(선택: 현재 세션 유지 옵션).
- Res: `{ message, revokedCount }`

### `GET /auth/sessions` — 접속 기기 목록 🔒
- Res: `{ sessions: [{ sid, label, ip, createdAt, lastUsedAt, current }] }`

### `DELETE /auth/sessions/:sid` — 특정 기기 로그아웃 🔒
- Res: `{ message }` · 404(없는 세션) · 403(내 세션 아님)

### `POST /auth/change-password` — 비밀번호 변경(로그인) 🔒
- Body: `{ code, oldPassword, newPassword }`
- 성공 시 전체 세션 종료 권장(현재 세션만 유지 옵션).
- Res: `{ message }`

### `POST /auth/reset-password` — 비밀번호 재설정(비로그인)
- Body: `{ email, code, newPassword }`
- 성공 시 해당 유저 전체 세션 종료.
- Res: `{ message }`

---

## 유저

### `GET /users/me` — 내 프로필·스탯 🔒
- Res: `{ id, email, nickname, stats, createdAt }`

### `DELETE /users/me` — 회원 탈퇴 🔒
- Body: `{ code, password }`
- 처리: `account_status = DELETED`, `status_changed_at` 세팅 → 전체 세션 종료. N일 유예 후 퍼지 잡이 익명화(§계정 상태). BANNED와 구분.
- Res: `{ message }`

> **계정 상태(`account_status`)**: `ACTIVE` / `DELETED`(자가삭제, N일 후 익명화+재가입 허용) / `BANNED`(관리자 정지, 영구 유지·재가입 불가). 로그인·조회는 `ACTIVE`만 통과. 관리자 정지는 별도 관리 도구/엔드포인트(TBD).

---

## 매치메이킹 (핸드오프)

성공 시 공통 반환: `{ gameServerUrl, roomId, ticket }` — 클라는 `gameServerUrl`에 WS 접속해 `ticket` 제시(§WS_PROTOCOL 연결). 로그인 유저는 Bearer 동봉(스탯/재접속용), 게스트는 `guestNickname` 사용.

- **인증**: 전부 비로그인 허용(게스트). 로그인 시 Bearer 동봉 → 티켓에 userId, 미동봉 시 게스트.
- **동시 게임 1개(로그인 한정)**: 로그인 유저가 이미 게임 중이면 409 거부 — `playing:{userId}` Redis 키(TTL, 게임서버가 관리 — 크래시 시 자동 해제) 검사. 게스트 미적용.

### `POST /match/quick` — 빠른 매칭
- Body: `{ guestNickname? }` (비로그인 시 필수)
- 처리: 참가 가능한 공개 WAITING 방 검색(`rooms:public:waiting`) → 있으면 그 방, 없으면 최소부하 게임서버에 새 방 예약(방장이 됨).
- Res: 공통 반환

### `POST /match/rooms` — 방 만들기
- Body: `{ roomName, isPublic, password?, mapId?, guestNickname? }`
- 처리: 최소부하 게임서버 선택 → roomId+roomCode 예약, `room:{roomId}`·`roomcode:{code}` 기록(**첫 입장 전까지 TTL** — 유령 방 방지. 방 비번은 room 레코드에 저장, join 시 매치서버가 검증). 생성자는 방장.
- Res: 공통 반환 + `{ roomCode }`

### `POST /match/rooms/join` — 코드로 참가
- Body: `{ roomCode, password?, guestNickname? }`
- 처리: `roomcode:{code}` → roomId·gameServerId 조회 → 해당 서버로 라우팅. 비번/정원/상태 검증(진행중이면 관전 입장 가능).
- Res: 공통 반환 · 404(없는 코드) · 401(비번 불일치) · 409(정원 초과)

### `GET /match/rooms` — 공개방 목록
- Query: `page?` (1페이지 최대 6개)
- Res: `{ currentPage, maxPage, rooms: [{ roomId, roomCode, name, ownerName, isPrivate, status, playerCount, maxPlayers }] }`

---

## 내부 (게임서버 → 매치서버)

매치 결과는 게임서버가 **Redis 스트림(`matchresults`)** 에 push하고 매치서버 워커가 소비→Postgres 반영(재시도). 별도 HTTP 엔드포인트 없음(게임서버는 계정 DB 미접근). 상세 → `ARCHITECTURE.md`.

> 🔒 = 로그인 필요(Bearer). TBD: 관리자용 밴/조회 엔드포인트, 닉네임 변경(`PATCH /users/me/nickname`).
