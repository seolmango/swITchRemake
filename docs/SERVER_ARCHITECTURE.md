# swITch 서버 아키텍처 설계

이 문서는 매칭 서버 1개와 여러 인게임 서버 프로세스로 구성되는 swITch 서버의 구현 기준을 정의한다.

이 문서는 여러 사람이 서로를 기다리지 않고 동시에 작업하기 위한 계약서이기도 하다. 절 사이에 충돌이 있으면 보안 절을 기준으로 고친다. 계약(바이너리 프로토콜, 제어 명령, JSON 메시지, 오류 코드)을 바꾸려면 이 문서를 먼저 고친다.

관련 문서:

- 클라이언트 렌더링 및 서버 스냅샷 프로토콜: `docs/ENGINE.md`
- 맵 빌드 도구: `tools/MapBuilder/builder.py`
- 레거시 게임 루프 참고 코드: `legacy/app.js`
- 경기 기록과 재생: `docs/REPLAY.md`
- 아직 구상 단계인 운영·공유 기능: `docs/FUTURE.md`

## 1. 설계 원칙

1. 서버가 모든 게임 판정을 수행한다.
2. 클라이언트는 입력 상태와 저빈도 행동 요청만 전송한다.
3. 방은 생성된 순간부터 종료될 때까지 하나의 인게임 서버 프로세스가 소유한다.
4. 대기실도 인게임 서버가 관리한다.
5. Redis의 게임 관련 용도는 서버 검색, 방 검색, 배정 명령, 경기 결과 전달로 제한한다. 매칭 서버의 인증 세션과 rate limit 저장은 별개 용도이며 keyspace를 분리한다.
6. 플레이어 위치와 같은 틱 상태는 Redis에 기록하지 않는다.
7. 맵 변화는 MapBuilder가 미리 계산한 타임라인을 런타임에서 적용한다.
8. 인게임 서버는 프로세스를 추가하는 방식으로 수평 확장한다.
9. 밸런스 값, 네트워크 값, 인프라 환경 값은 서로 다른 설정 파일로 관리한다.
10. Docker 및 배포 자동화는 서버 기능과 부하 테스트가 완료된 뒤 추가한다.
11. 신원은 매칭 서버만, 게임 판정은 인게임 서버만 결정한다.
12. 클라이언트와 서버가 공유하는 모든 계약은 `shared` 패키지에 단일 정의로 둔다. 같은 상수를 양쪽에 복사하지 않는다.
13. 나중에 만들 기능이라도 **경계와 버전 식별자**는 지금 넣는다. 기능 자체는 미뤄도 된다. 자세한 범위는 미래 기능 대비 절을 본다.

## 2. 전체 구조

```text
                             PostgreSQL
                                 ▲
                                 │
Client ── HTTPS ──> Matching Server
   │                             │
   │                             │ Redis control plane
   │                             ▼
   │                       Server registry
   │                       Room directory
   │                       Command streams
   │                       Result stream
   │
   └── WSS ──> Reverse Proxy ─┬─ Game Server process 1 ─ rooms A, B
                              ├─ Game Server process 2 ─ rooms C, D
                              └─ Game Server process N ─ rooms ...
```

외부에서는 하나의 도메인만 사용한다.

```text
https://switch.example.com/api/*          -> matching server
wss://switch.example.com/game/{serverId}  -> selected game server process
```

리버스 프록시는 WebSocket upgrade 시점에 `serverId`를 기준으로 대상 프로세스를 선택한다. 연결된 뒤에는 해당 연결이 종료될 때까지 같은 프로세스로 유지된다. 애플리케이션 WebSocket 게이트웨이를 별도로 두지 않아 불필요한 네트워크 홉과 단일 병목을 만들지 않는다.

`serverId`는 비밀이 아니다. 경로에 그대로 노출되는 값이므로 어떤 접근 통제도 `serverId`의 비공개성에 기대지 않는다. 접근 통제는 전적으로 접속 티켓이 담당한다.

## 3. 보안 모델과 신뢰 경계

이 절은 아래 모든 절보다 우선한다. 다른 절의 설계가 이 절과 충돌하면 이 절을 기준으로 고친다.

### 3.1 신뢰 경계

| 주체 | 신뢰 수준 | 이유 |
| --- | --- | --- |
| 클라이언트 | 신뢰하지 않음 | 조작 가능하다. 입력 의도만 받는다 |
| 매칭 서버 | 신뢰 | 사용자 신원의 유일한 판정자 |
| 인게임 서버 | 신뢰 | 게임 판정의 유일한 판정자 |
| Redis | 반신뢰 | 내부망 전용. 접근 통제가 뚫리면 방 배정과 전적이 통째로 위조된다 |
| 리버스 프록시 | 신뢰 | TLS 종료와 클라이언트 IP 판정을 담당한다 |

신원(`userId`, `nickname`)은 매칭 서버만 결정한다. 인게임 서버는 클라이언트가 보낸 신원 필드를 어떤 경우에도 읽지 않는다.

게임 판정(좌표, 속도, 쿨타임, 술래, 탈락)은 인게임 서버만 결정한다. 매칭 서버는 게임 판정에 개입하지 않는다.

### 3.2 인증 요구 사항

- 매칭 서버의 모든 방 API(`GET /rooms`, `POST /rooms`, `POST /rooms/{roomId}/join`, `POST /rooms/quick-join`)는 유효한 access token을 요구한다. 인증 없이 접근 가능한 것은 `/health`와 인증 자체 엔드포인트뿐이다.
- access token은 `Authorization` 헤더로만 받는다. 쿼리 스트링에 토큰을 싣지 않는다. 프록시 로그와 브라우저 히스토리에 남는다.
- refresh token은 httpOnly, secure, sameSite 쿠키로만 다룬다. 현재 구현과 동일하다.
- 세션(refresh token)의 권위 저장소는 PostgreSQL이다. 자세한 규칙은 아래 세션 관리 항목을 따른다.
- 인게임 서버는 JWT 비밀키를 갖지 않는다. 인게임 서버가 아는 신원은 접속 티켓에 실려 온 값뿐이다. 인게임 프로세스 한 대가 뚫려도 토큰을 위조할 수 없어야 한다.
- 계정 상태(정지, 탈퇴)는 매칭 서버가 배정 시점에 확인한다. 인게임 서버는 확인하지 않는다.

### 3.3 세션 관리

세션은 Redis가 아니라 PostgreSQL에 둔다. Redis도 AOF로 재시작을 견디므로 영속성이 이유는 아니다. 이유는 세션을 **목록으로 보여주고 하나씩 취소해야** 하기 때문이다. 기기 목록 조회, 특정 기기 로그아웃, 밴 시 전체 세션 무효화는 모두 여러 행을 조건으로 조회하고 지우는 작업이라 관계형 테이블이 맞다. Redis로 하면 사용자별 세션 집합과 세션 본문을 따로 들고 직접 동기화해야 하고, 한쪽 키만 만료되면 집합에 유령 항목이 남는다.

```text
sessions
  id                 uuid, pk
  user_id            users.id 참조, 인덱스
  refresh_token_hash refresh token의 SHA-256. 원문은 저장하지 않는다
  device_label       사용자에게 보여줄 이름. User-Agent에서 추출
  ip_hmac            HMAC(서버 비밀키, 정규화한 IP). 상관관계 분석용
  ip_encrypted       원본 IP. 짧은 기간만 보관하고 기한이 지나면 지운다
  created_at
  last_used_at
  expires_at
  revoked_at         null이면 유효
```

- 한 사용자가 여러 기기에서 동시에 로그인할 수 있다. 로그인마다 새 행을 만든다. 지금 구현은 사용자당 키 하나(`auth:refresh:{userId}`)라서 새 기기 로그인이 기존 기기를 조용히 밀어낸다. 이 동작을 없앤다.
- refresh token 원문은 저장하지 않고 해시만 저장한다. DB가 유출돼도 세션을 탈취당하지 않아야 한다.
- refresh 요청이 오면 해시로 행을 찾고, 만료와 `revoked_at`을 확인한 뒤 회전시킨다. 기존 행을 무효화하고 새 행을 만든다.
- 이미 무효화된 refresh token이 다시 오면 탈취 정황으로 간주한다. 해당 사용자의 모든 세션을 무효화하고 재로그인을 요구한다.
- 계정 관리 화면에서 세션 목록을 보여주고, 개별 로그아웃과 다른 기기 전체 로그아웃을 제공한다.
- 계정 정지나 탈퇴 시 상태 변경과 세션 삭제를 같은 트랜잭션에서 처리한다. 이것이 저장소를 하나로 모으는 실질적 이득이다.
- `users`에 계정 상태 컬럼을 추가한다. 현재 스키마에는 없다. 최소 `ACTIVE`, `BANNED`, `DELETED`가 필요하다.
- access token은 짧게 유지한다. 세션을 무효화해도 이미 발급된 access token은 만료까지 유효하므로, 그 시간이 곧 밴 반영 지연 시간이다.
- 게스트 세션은 저장하지 않는다. 게스트는 refresh 대상이 아니다.
- **IP는 처음부터 두 컬럼으로 나눠 저장한다.** 장기 보관은 `HMAC(비밀키, 정규화 IP)`만 하고, 원본은 짧은 기간 암호화 보관 후 지운다. 단순 SHA 해시는 익명화가 아니다. IPv4 전체 공간이 43억 개라 전수 대입으로 원본을 복원할 수 있다.
- IP 컬럼 형태는 첫 행을 쓰는 순간 사실상 고정된다. 나중에 바꾸려면 이미 쌓인 원본 IP를 소급 처리해야 하고, 그 사이 보관 기간을 초과한 개인정보가 남는다. 그래서 이 항목만은 세션 테이블을 만들 때 함께 정한다. 배경은 `docs/FUTURE.md`의 IP 취급 절에 있다.

Redis에 남는 인증 관련 데이터는 이메일 인증 코드와 rate limit 카운터뿐이다. 둘 다 날아가도 무해한 값이다.

### 3.4 접속 티켓 규격

티켓은 이 아키텍처에서 가장 민감한 값이다. 티켓 하나가 곧 "이 사람이 이 방의 이 자리에 앉을 권한"이며, 유출되면 계정 사칭과 동일하다.

- 티켓 값은 CSPRNG로 만든 256비트 난수를 base64url로 인코딩한 불투명 문자열이다. `roomId + timestamp` 해시처럼 추측 가능한 값은 쓰지 않는다.
- 티켓 발급 주체는 그 방을 소유한 인게임 서버다. 인게임 서버는 티켓 원문을 저장하지 않고 SHA-256 해시를 키로 예약 정보를 보관한다.

```ts
interface SeatReservation {
    userId: number;
    nickname: string;
    lobbyStats: { games: number; wins: number; switchSuccessRate: number } | null;
    roomId: string;
    serverId: string;
    issuedAt: number;
    expiresAt: number;
    resume: boolean;
}
```

`lobbyStats`는 매칭 서버가 예약 시점의 계정 전적에서 만든 표시 전용 요약이다. 게스트는 `null`이다. 인게임 서버는 이 값을 게임 판정에 사용하지 않고 `lobby.state`로 전달만 한다.

- 검증 시 다음을 모두 확인한다. 하나라도 어긋나면 거절한다.
  1. 해시가 예약 테이블에 존재한다.
  2. `expiresAt`이 지나지 않았다.
  3. `serverId`가 이 프로세스 자신이다.
  4. `roomId`의 방이 아직 존재하고 그 자리 예약이 유효하다.
  5. 같은 `userId`의 다른 활성 연결이 없다.
- 검증에 성공하면 즉시 예약 항목을 제거한다. 조회와 제거는 한 번의 원자적 연산으로 한다. 티켓 하나로 두 연결이 붙는 경합을 막는다.
- 실패 응답은 사유와 무관하게 같은 오류 코드와 비슷한 지연 시간을 갖는다. 티켓 존재 여부가 응답 차이로 새면 안 된다.
- 티켓은 URL 경로나 쿼리 스트링에 넣지 않는다. 접속 후 첫 메시지로만 전달한다.
- 티켓 TTL은 예약 TTL과 같은 15초다. 재접속 티켓도 동일한 규격을 따른다.

### 3.5 WebSocket 연결 보호

WebSocket upgrade는 브라우저의 동일 출처 정책을 적용받지 않는다. 다른 사이트가 사용자의 브라우저로 우리 게임 서버에 연결을 열 수 있으므로 upgrade 시점에 다음을 검사한다.

- `Origin` 헤더가 허용 목록에 없으면 upgrade를 거절한다. 허용 목록은 `infrastructure.ts`에서 환경 변수로 주입한다.
- 인증 전 연결은 IP당 개수를 제한한다(기본 5개). 5초 안에 `auth` 메시지를 보내지 않으면 종료한다.
- 인증 전 연결에서는 `auth` 외의 어떤 메시지도 파싱하지 않는다.
- 프로세스 전체 동시 연결 상한을 두고 초과 시 upgrade를 거절한다. 상한 도달은 heartbeat의 부하 지표에 반영한다.
- 클라이언트 IP는 리버스 프록시가 넣는 헤더에서 읽되, 신뢰하는 프록시 주소에서 온 요청에 대해서만 그 헤더를 인정한다. 지금 매칭 서버는 `trustProxy: true`를 무조건 켜고 있어 프록시를 거치지 않는 경로가 열려 있으면 IP 위조가 가능하다. rate limit이 IP 기반이므로 실제 위험이다.

### 3.6 메시지 남용 방지

| 항목 | 기본값 | 초과 시 |
| --- | --- | --- |
| 바이너리 프레임 크기 | 64 B | 연결 종료 |
| JSON 프레임 크기 | 2 KB | 연결 종료 |
| 입력 패킷 | 90개/초 | 무시. 지속되면 종료 |
| JSON 명령 | 20개/초 | 거부 응답. 지속되면 종료 |
| 이모지 | 2초당 1개 | 거부 응답 |
| 방 비밀번호 시도 | 방당 10회/분, 사용자당 20회/분 | 거부 응답 |

값은 모두 `network.ts`에 둔다. 위반 집계는 연결 단위뿐 아니라 `userId`와 IP 단위로도 유지해 재접속으로 초기화되지 않게 한다.

위반을 감지한 자리에서 바로 로그를 찍지 말고, 구조화된 위반 이벤트 하나를 만들어 단일 지점으로 넘긴다.

```ts
interface ViolationSignal {
    kind: ViolationKind;   // RATE_LIMIT, BAD_LENGTH, BAD_STATE, SPECTATOR_INPUT 등
    userId: number | string;
    roomId: string | null;
    tick: number | null;
    severity: 'low' | 'medium' | 'high';
    ruleVersion: number;
    detail?: Record<string, number | string>;
}
```

초기 구현에서 이 신호의 소비자는 로그 하나뿐이어도 된다. 중요한 건 감지 지점이 소비자를 모른다는 점이다. 나중에 안티치트 저장소나 운영자 화면을 붙일 때 소비자만 추가하면 되고, 흩어진 `console.log`를 스무 군데 찾아다니지 않아도 된다. 신호 종류와 심각도 기준은 `docs/FUTURE.md`의 안티치트 절을 따른다.

`ruleVersion`을 신호에 넣는 이유는, 탐지 기준이 바뀐 뒤에도 과거 판단을 설명할 수 있어야 하기 때문이다.

### 3.7 입력 데이터 검증

- 바이너리 입력 패킷은 길이가 정확히 일치할 때만 처리한다. 부족하거나 남으면 패킷 전체를 버린다.
- JSON 메시지는 알려진 `type`과 스키마에 맞을 때만 처리한다. 필수 필드 누락은 거부하고, 모르는 필드는 무시한다.
- `emojiId`, `mapId`, `skillSlot`처럼 열거값인 필드는 서버가 가진 허용 목록으로 검사한다. 클라이언트가 보낸 정수를 그대로 배열 첨자로 쓰지 않는다.
- 닉네임과 방 이름은 매칭 서버가 소유한다. 인게임 서버는 클라이언트가 보낸 표시 이름을 받지 않는다. ROSTER 섹션의 이름은 티켓에 실려 온 값이다.
- 방 이름은 길이와 문자 범위를 매칭 서버에서 검증하고 제어 문자를 제거한 뒤 저장한다. 방 이름은 다른 사용자 화면에 그대로 표시된다.

### 3.8 방 비밀번호

- 비밀번호 원문은 방을 소유한 인게임 서버 메모리에만 둔다. Redis room directory에는 `hasPassword: boolean`만 넣는다. 클라이언트 `RoomSummary`도 이미 같은 형태다.
- 비교는 상수 시간 비교를 쓴다.
- 클라이언트에 내려가는 실패 사유는 "방 없음"과 "비밀번호 불일치"를 구분하지 않는다. 비공개 방의 존재 여부가 새면 안 된다.
- 비밀번호 길이 상한(기본 32자)을 매칭 서버에서 강제한다.

### 3.9 경기 결과 신뢰

경기 결과는 XP와 전적에 직결된다. 결과 stream에 쓸 수 있는 주체가 곧 전적을 위조할 수 있는 주체다.

- Redis ACL로 `game-results` stream 쓰기를 인게임 서버 계정으로 제한한다.
- 결과에는 매칭 서버가 방 배정 때 발급한 `matchId`를 포함한다. 매칭 서버는 자신이 발급하지 않은 `matchId`의 결과를 버린다.
- 참가자 집합은 배정 시점에 기록한 명단의 부분집합이어야 한다. 경기 시간, 인원수, 킬 수는 상한을 넘으면 저장하지 않고 이상 징후로 기록한다.
- `matchId`에 DB unique 제약을 건다. 멱등성은 애플리케이션 로직이 아니라 제약 조건으로 보장한다.

### 3.10 Redis 접근 통제

`docker-compose.yml`은 다음까지 반영돼 있다.

- Redis `requirepass` 필수. `REDIS_PASSWORD`가 비어 있으면 컨테이너가 뜨지 않는다.
- Redis와 PostgreSQL 포트를 `127.0.0.1`에만 바인딩한다. 같은 네트워크의 다른 기기에서 직접 붙을 수 없다.
- Redis는 `appendonly yes`, `appendfsync everysec`로 재시작을 견딘다.

남은 항목:

- 매칭 서버용과 인게임 서버용 Redis ACL 사용자를 분리한다. 인게임 서버 계정은 자기 `game-server:{serverId}:*` 키와 결과 stream, room directory에만 접근할 수 있어야 한다. 지금은 단일 비밀번호로 전부 접근 가능하다.
- 배포 시에는 포트 바인딩 자체를 없애고 컨테이너 네트워크 안에서만 통신한다.
- 환경 prefix(`dev`, `staging`, `prod`)를 키 생성 헬퍼에서 강제한다. prefix를 붙이지 않은 직접 키 접근을 코드에서 금지한다.

### 3.11 방 참가 남용 방지

방 참가는 인증만 통과하면 반복 호출할 수 있고, 참가 하나하나가 인게임 서버의 방 상태를 건드린다. 참가 자체를 제한하지 않으면 시작 잠금 남용, 자리 점유, 인게임 서버 명령 폭주가 모두 같은 경로로 가능하다. 매칭 서버가 1차 방어선이다.

- **같은 방 재참가 쿨다운**: 방을 나간 뒤 기본 60초 동안 같은 방에 다시 참가할 수 없다. `room-rejoin:{roomId}:{userId}` 키를 퇴장 시각 기준 TTL로 잡는다. 들어왔다 나가기를 반복하는 공격은 이 규칙 하나로 끊긴다. 실수로 나간 사용자는 1분을 기다려야 하지만, 그 대가로 방 하나가 인질이 되는 상황을 막는다.
- **참가 빈도 제한**: 사용자당 방 참가 요청을 분당 6회로 제한한다. 방을 바꿔가며 여러 방을 돌아다니는 경우를 막는다.
- **강퇴 이력 반영**: 인게임 서버가 강퇴를 처리하면 매칭 서버에도 알려 그 방에 대한 배정을 아예 거절한다. 인게임 서버까지 명령이 가기 전에 걸러진다.
- **게스트는 IP 단위로도 건다**: 게스트는 신원을 새로 발급받아 사용자 단위 제한을 우회할 수 있다. 게스트의 재참가 쿨다운과 참가 빈도 제한은 게스트 식별자와 IP 양쪽에 적용한다. 게스트 신원 발급 자체에도 IP당 제한이 걸려 있어야 이 방어가 성립한다.
- 위 제한에 걸린 요청은 남은 대기 시간과 함께 거절한다. 무엇에 걸렸는지 알려주지 않으면 정상 사용자가 고장으로 오해한다.

이 제한들은 매칭 서버 메모리가 아니라 Redis에 둔다. 지금은 매칭 서버가 한 프로세스지만, 재시작으로 제한이 통째로 풀리면 안 된다.

### 3.12 한 사용자 한 게임

한 사용자가 여러 방을 동시에 점유하면 자리 고갈과 다중 접속 어뷰징이 가능하다.

- 매칭 서버는 배정 시 `user:{userId}:active-room` 키를 `NX`로 잡는다. 이미 있으면 새 배정을 거절하고 기존 방 정보를 반환한다.
- 이 키의 TTL은 인게임 서버 heartbeat로 갱신하고, 퇴장과 방 종료 시 `RELEASE_SEAT`로 해제한다.
- 인게임 서버도 같은 `userId`의 두 번째 활성 연결을 거절한다. Redis 키가 유실돼도 방 단위에서는 막힌다.

### 3.13 게스트 접속

게스트 플레이를 허용한다. 게스트도 정식 사용자와 완전히 같은 경로로만 인게임 서버에 접근한다. 인증 없이 인게임 서버에 직접 붙는 경로는 어떤 경우에도 만들지 않는다.

- 클라이언트가 `POST /auth/guest`를 호출하면 매칭 서버가 게스트 신원과 단명 access token을 발급한다.
- 닉네임은 서버가 정한다. `Guest_` 뒤에 CSPRNG 난수에서 뽑은 짧은 문자열을 붙인다. 기본 6자이며 혼동하기 쉬운 문자(0/O, 1/I/l)는 제외한다. 클라이언트는 게스트 닉네임을 지정할 수 없다.
- 게스트 식별자는 정식 `users.id`와 겹치지 않는 네임스페이스를 쓴다. token payload에 `guest: true`를 넣고 내부 식별자는 `g:{uuid}` 형태로 둔다. 정식 사용자 id 공간에 게스트를 섞으면 전적 집계에서 사고가 난다.
- 게스트 토큰은 refresh 대상이 아니다. 만료되면 새 게스트 신원을 발급한다. 게스트 세션은 어디에도 영속화하지 않는다.
- 게스트는 전적 저장 대상이 아니다. 경기 결과 메시지에는 `userId: null`로 포함되고, 결과 저장 worker는 `match_participants` 행만 남긴 뒤 `users.stats` 갱신에서 제외한다.
- 게스트에게도 한 사용자 한 게임 제약을 적용한다. 키는 게스트 식별자 기준이다.
- 게스트 신원은 얼마든지 새로 발급받을 수 있으므로 신원 단위 rate limit만으로는 의미가 없다. 게스트 신원 발급 자체를 IP당 제한하고, 게스트의 방 생성과 참가 제한도 IP 단위로 함께 건다.
- 게스트의 방 생성 허용 여부는 운영하면서 조정한다. 초기값은 정식 사용자와 동일하게 둔다.

## 4. 매칭 서버 책임

매칭 서버는 현재의 NestJS/Fastify 구조를 유지한다.

- 로그인, 토큰 발급, 프로필 및 전적 API
- 방 목록 조회
- 방 생성, 방 참가, 빠른 참가 요청 접수
- Redis heartbeat를 이용한 인게임 서버 가용성 확인
- 부하가 낮고 호환되는 인게임 서버 선택
- 선택된 인게임 서버에 방 생성 또는 자리 예약 명령 전달
- 클라이언트에 WebSocket 경로와 일회용 접속 티켓 반환
- 계정 상태(정지, 탈퇴) 확인과 배정 차단
- 한 사용자 한 게임 제약 관리
- 인게임 서버가 제출한 경기 결과를 PostgreSQL에 멱등 저장

방 관련 API는 모두 유효한 access token을 요구한다. 매칭 서버는 방 내부 상태를 직접 수정하지 않는다. Redis에 보이는 방 목록은 검색용 projection이며, 실제 방 상태의 권위자는 해당 방을 소유한 인게임 서버다.

## 5. 인게임 서버 책임

인게임 서버는 NestJS 없이 가벼운 TypeScript 프로세스로 작성한다.

- WebSocket 연결 및 backpressure 관리
- 일회용 접속 티켓 검증
- 방 생성과 참가 예약
- 대기실 상태 및 방장 관리
- 맵 선택, 강퇴, 시작 잠금, 게임 시작 검증
- 고정 timestep 게임 루프
- 입력에 따른 속도와 이동량 계산
- 벽, 자기장, 플레이어 충돌 계산
- 술래 접촉, 스킬, 쿨타임, 탈락 판정
- 플레이어별 시야와 은신 정보 계산
- 관전 자격 판정과 관전자용 비검열 스냅샷 생성
- 연결별 바이너리 스냅샷 생성
- 게임 종료 결과 제출

한 프로세스는 여러 방을 관리할 수 있다. 프로세스는 CPU 코어 하나를 주로 사용한다고 가정하며, 한 호스트에서 여러 프로세스를 실행할 수 있다.

## 6. 인게임 서버 수평 확장

당장은 인게임 서버도 프로세스 하나로 운영한다. 이 절의 설계는 나중에 프로세스를 늘릴 수 있게 길을 열어두기 위한 것이고, 초기 구현에서 실제로 여러 프로세스를 띄우지는 않는다. 다만 `serverId`를 통한 배정 경로는 처음부터 넣는다. 나중에 끼워 넣으면 방 소유 모델 전체를 건드려야 한다.

프로세스당 방 수는 추정하지 않고 측정해서 정한다. 8인 풀방 하나를 돌리며 tick 처리 시간과 loop lag를 재고, 방 수를 늘려가며 목표 tick rate가 무너지는 지점을 찾는다. 그 지점의 절반 정도를 운영 상한으로 잡는다. 이 값이 나오기 전에는 `draining` 임계값과 연결 상한을 확정하지 않는다.

각 프로세스는 고유한 `serverId`를 가진다. 예를 들어 `game-seoul-01-p2`처럼 호스트와 프로세스를 구분할 수 있어야 한다.

인게임 서버는 약 2초마다 다음 정보를 Redis에 갱신한다.

```ts
interface GameServerHeartbeat {
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
```

매칭 서버는 heartbeat가 일정 시간 이상 갱신되지 않은 프로세스, `draining` 상태인 프로세스, 클라이언트와 프로토콜 버전이 맞지 않는 프로세스를 배정 대상에서 제외한다.

`game-server:{serverId}` 키에는 heartbeat 주기의 3배(기본 6초) TTL을 건다. 프로세스가 죽으면 registry에서 스스로 사라져야 하며, 매칭 서버가 `updatedAt` 값만 보고 판단하게 두지 않는다. `game-servers:alive` 인덱스에서도 만료된 항목을 주기적으로 제거한다.

프로세스가 비정상 종료되면 그 프로세스가 소유하던 `room:{roomId}` 키가 남아 유령 방이 목록에 보인다. 방 요약 키에도 같은 TTL을 걸고 소유 프로세스가 heartbeat마다 갱신한다. 매칭 서버는 방 목록을 만들 때 소유 `serverId`가 살아 있는 방만 노출한다.

게임 서버 프로세스를 추가하면 별도 코드 변경 없이 Redis registry에 등록되고 신규 방을 받는다. 프로세스를 종료하거나 배포할 때는 먼저 `draining`으로 전환하고, 기존 방이 모두 종료된 뒤 프로세스를 내린다.

초기 버전에서는 실행 중인 방을 다른 프로세스로 이전하지 않는다. 프로세스가 비정상 종료되면 해당 방은 종료되고 클라이언트는 매칭 화면으로 돌아간다.

## 7. 방 생성 및 참가 흐름

### 7.1 방 생성

1. 클라이언트가 access token과 함께 매칭 서버에 `POST /rooms`를 요청한다.
2. 매칭 서버가 계정 상태와 한 사용자 한 게임 제약을 확인하고, Redis에서 적합한 인게임 서버를 선택한다.
3. 매칭 서버가 `matchId`를 발급하고 해당 서버의 command stream에 `CREATE_ROOM`을 기록한다.
4. 인게임 서버가 방을 생성하고 첫 사용자를 위한 예약과 일회용 티켓을 만든다.
5. 인게임 서버가 reply stream으로 결과를 반환한다.
6. 매칭 서버가 `{ roomId, wsPath, ticket, expiresAt }`을 클라이언트에 반환한다.
7. 클라이언트가 `wss://domain/game/{serverId}`에 연결하고 티켓을 인증한다.

### 7.2 방 참가

1. 클라이언트가 매칭 서버에 방 ID와 비밀번호를 제출한다.
2. 매칭 서버가 계정 상태, 한 사용자 한 게임, 재참가 쿨다운, 참가 빈도, 강퇴 이력을 확인한다. 하나라도 걸리면 인게임 서버에 명령을 보내지 않는다.
3. 매칭 서버가 room directory에서 방을 소유한 `serverId`를 찾는다.
4. 해당 인게임 서버에 `RESERVE_JOIN` 명령을 보낸다.
5. 인게임 서버가 비밀번호, 방 상태, 방 잠금, 정원, 중복 접속, 방 단위 차단 목록을 검사한다.
6. 참가 가능할 때만 자리와 티켓을 짧은 시간 예약한다.
7. 클라이언트가 해당 인게임 서버에 직접 연결한다.
8. 참가가 확정되면 인게임 서버가 시작 잠금을 갱신하고 `lobby.state`를 방 전체에 보낸다.

예약은 기본 15초 후 만료한다. 티켓은 한 번만 사용할 수 있으며 인증 성공 직후 폐기한다. HTTP 응답이 유실되거나 사용자가 연결하지 않아도 예약이 자동으로 풀려야 한다. 티켓 값의 생성, 저장, 검증 규칙은 보안 절의 접속 티켓 규격을 따른다.

브라우저 WebSocket에서 임의 인증 헤더를 사용할 수 없으므로 접속 직후 첫 JSON 메시지로 티켓을 전송한다. 인증 제한 시간은 기본 5초다.

```json
{"v":1,"type":"auth","ticket":"one-time-ticket"}
```

### 7.3 실패 경로

- 예약만 되고 클라이언트가 접속하지 않으면 TTL 만료로 자리가 풀린다.
- 방 생성은 성공했지만 응답이 매칭 서버에 닿지 못하면 방장이 없는 방이 남는다. 인게임 서버는 생성 후 예약 TTL 안에 아무도 접속하지 않은 방을 즉시 닫는다.
- 클라이언트가 티켓을 받고도 접속에 실패하면 매칭 서버에 다시 요청한다. 새 요청은 새 `requestId`를 쓰며, 한 사용자 한 게임 제약에 따라 기존 방 정보를 그대로 돌려받는다.
- 매칭 서버가 응답 대기 시간을 넘기면 클라이언트에는 재시도 가능 오류를 반환한다. 이미 만들어졌을 수 있는 방은 위 규칙으로 스스로 정리된다.

## 8. 매칭 서버와 인게임 서버 사이의 계약

이 절은 매칭 서버 담당자와 인게임 서버 담당자가 서로를 기다리지 않고 동시에 작업하기 위한 고정 계약이다. 타입 정의는 `shared/src/control/`에 두고 양쪽이 import 한다. 계약을 바꾸려면 양쪽 담당자가 함께 바꾼다.

### 8.1 명령 봉투

```ts
interface ControlCommand<T> {
    v: 1;
    requestId: string;    // UUID v4. 멱등 키
    type: CommandType;
    issuedAt: number;     // epoch ms
    deadlineAt: number;   // 이 시각을 넘겨 도착한 명령은 부수 효과 없이 만료 응답
    payload: T;
}

interface ControlReply<T> {
    v: 1;
    requestId: string;
    serverId: string;
    ok: boolean;
    code: ControlErrorCode | null;   // ok가 false일 때만 채운다
    payload: T | null;
}
```

`deadlineAt`이 필요한 이유는 stream 재전달 때문이다. 매칭 서버가 이미 타임아웃으로 포기한 요청이 몇 초 뒤 처리되어 유령 방이 남는 상황을 막는다.

### 8.2 명령 목록

| type | payload | 성공 payload | 실패 코드 |
| --- | --- | --- | --- |
| `CREATE_ROOM` | `{ matchId, roomName, password, ownerUserId, ownerNickname, ownerLobbyStats, capacity, mapId }` | `{ roomId, wsPath, ticket, expiresAt }` | `SERVER_DRAINING`, `SERVER_FULL`, `INVALID_MAP`, `EXPIRED` |
| `RESERVE_JOIN` | `{ roomId, userId, nickname, lobbyStats, password }` | `{ wsPath, ticket, expiresAt }` | `ROOM_NOT_FOUND`, `ROOM_FULL`, `ROOM_LOCKED`, `BAD_PASSWORD`, `ALREADY_IN_ROOM`, `KICKED_FROM_ROOM`, `REJOIN_COOLDOWN`, `EXPIRED` |
| `RESERVE_RESUME` | `{ roomId, userId }` | `{ wsPath, ticket, expiresAt }` | `ROOM_NOT_FOUND`, `NO_GRACE_SLOT`, `EXPIRED` |
| `RELEASE_SEAT` | `{ roomId, userId }` | `{}` | `ROOM_NOT_FOUND` |
| `KICK_USER` | `{ roomId, userId, reason }` | `{}` | `ROOM_NOT_FOUND` |

`ROOM_LOCKED`는 방이 `COUNTDOWN` 이후 상태이거나 방장이 방을 잠근 경우다.

`REJOIN_COOLDOWN`과 `KICKED_FROM_ROOM`은 매칭 서버가 인게임 서버에 명령을 보내기 전에 먼저 거른다. 여기 실패 코드로 남겨두는 것은 매칭 서버의 기록이 유실됐을 때 인게임 서버가 마지막으로 한 번 더 막기 때문이다.

`ROOM_NOT_FOUND`와 `BAD_PASSWORD`는 내부적으로는 구분하지만 클라이언트에는 같은 코드로 내려간다. 보안 절의 비밀번호 규칙을 따른다.

### 8.3 응답과 멱등성

- 인게임 서버는 결과를 `matching-server:replies`에 쓴 뒤에 명령을 `XACK`한다. 순서를 바꾸면 결과 유실이 생긴다.
- 인게임 서버는 `requestId`별 처리 결과를 짧은 TTL(기본 60초) 동안 보관하고, 같은 `requestId`가 재전달되면 부수 효과 없이 같은 결과를 다시 반환한다.
- 매칭 서버의 응답 대기 시간은 기본 2초다. 초과하면 클라이언트에 재시도 가능 오류를 반환한다. 이때 이미 만들어졌을 수 있는 방과 자리는 예약 TTL과 빈 방 정리 규칙으로 스스로 사라져야 한다.
- 매칭 서버는 프로세스 하나로 운영한다. 따라서 대기 중인 HTTP 요청과 도착한 응답을 잇는 것은 프로세스 메모리의 `requestId -> pending` 맵으로 충분하다. 공유 저장소가 필요 없다.
- 나중에 매칭 서버를 여러 프로세스로 늘리게 되면 이 부분만 바뀐다. 명령에 요청자 프로세스 id를 싣고 응답을 프로세스별 stream으로 되돌리는 방식이 자연스럽다. 지금은 구현하지 않는다.

### 8.4 경기 결과 메시지

```ts
interface MatchResultMessage {
    v: 1;
    matchId: string;
    roomId: string;
    serverId: string;
    mapId: string;
    startedAt: number;
    endedAt: number;
    durationTicks: number;

    // 이 경기가 "어떤 규칙과 어떤 코드로" 진행됐는지. 나중에 채울 수 없는 값들이다.
    buildId: string;
    protocolVersion: number;
    rulesVersion: string;
    mapBundleHash: string;
    visibilityCoreVersion: number;

    // 최후까지 남은 두 명. 둘 모두 공동 승리자.
    // 계정이 아니라 방 범위 slot으로 지목한다. 게스트도 이길 수 있기 때문이다.
    winnerPlayerIds: [number, number];

    // 리플레이를 기록하지 못했으면 null. 기록 실패가 결과 저장을 막지 않는다.
    replay: {
        storageKey: string;
        formatVersion: number;
        chunkCount: number;
        sizeBytes: number;
        rootHash: string;
    } | null;

    players: Array<{
        userId: number | null;  // 게스트는 null. 행 자체는 남긴다
        playerId: number;       // 방 범위 slot. 리플레이·신고가 가리키는 값
        nickname: string;       // 경기 당시 닉네임
        tagCount: number;       // 술래로서 잡은 수
        taggedCount: number;    // 잡힌 수
        switchTry: number;
        switchSuccess: number;
        survivedMs: number;
    }>;
}
```

이 게임에는 등수 개념이 없다. 종료 조건을 만족했을 때 최후까지 남은 두 명을 `winnerPlayerIds`로 기록하고 둘 모두 승리로 집계한다. 다른 참가자도 순위를 만들지 않고 경기 중 발생한 원자적 통계만 저장한다.

`players`에는 게스트도 포함하되 `userId`를 `null`로 보낸다. 전적 집계에서만 제외하고 행은 남긴다. 리플레이 재생과 신고 조사는 경기에 있던 전원의 `playerId`와 당시 닉네임을 필요로 하며, 게스트를 빼면 리플레이에 이름 없는 캐릭터가 돌아다닌다. 매칭 서버는 `userId`가 있는 참가자에 대해서만 `users.stats`를 갱신한다.

승자를 계정이 아니라 `playerId`로 지목하는 이유는 게스트도 이길 수 있기 때문이다. `userId` 배열로 두면 게스트 승리를 표현할 방법이 없다. 계정 연결은 매칭 서버가 `players`에서 찾는다. JSON 이벤트 `game.ended`의 `winnerIds`도 같은 `playerId` 공간을 쓴다.

필드 이름은 `users.stats` jsonb의 기존 키(`games`, `wins`, `sw_try`, `sw_su`, `kill`)와 매칭 서버에서 매핑한다. `wins`는 `winnerPlayerIds`가 가리키는 참가자 중 `userId`가 있는 쪽만 1회씩 증가한다. 게스트 승자는 집계하지 않는다. 스탯 집계 규칙은 매칭 서버 담당 영역이며, 인게임 서버는 위 원자적 수치만 보고한다.

전적 저장은 `stats` jsonb 갱신만으로 끝내지 않고 `matches`와 `match_participants` 두 테이블에 남긴다. `matchId` unique 제약이 붙을 자리가 필요하고, 나중에 전적 상세와 재집계가 가능해야 한다.

버전 필드와 `nickname`을 지금 넣는 이유는 **나중에 채울 수 없는 값**이기 때문이다.

- 버전 필드가 없으면 "이 경기는 어떤 규칙으로 판정됐는가"를 사후에 알 수 없다. 밸런스를 고친 뒤 과거 경기를 조사하면 지금 코드 기준으로 해석하게 된다.
- `nickname`을 저장하지 않고 `users`를 조인하면 닉네임을 바꾼 순간 과거 전적과 신고 기록의 이름이 전부 소급해서 바뀐다.
- `playerId`가 없으면 신고나 리플레이가 가리키는 slot 번호를 계정과 연결할 수 없다.

세 값 모두 컬럼을 나중에 추가할 수는 있지만, 추가 이전 경기의 값은 영원히 비어 있다.

## 9. Redis 사용 규칙

Redis는 게임 데이터 plane이 아니라 control plane이다.

예상 키와 stream은 다음과 같다. 실제 키에는 `dev`, `staging`, `prod` 환경 prefix를 붙인다.

```text
game-server:{serverId}                 heartbeat와 용량. TTL 6초
game-servers:alive                     마지막 heartbeat 시각 인덱스
room:{roomId}                          검색용 방 요약. TTL 6초, 소유 서버가 갱신
rooms:waiting                          대기방 검색 인덱스
user:{userId}:active-room              한 사용자 한 게임 제약
game-server:{serverId}:commands        매칭 서버 -> 인게임 서버 명령 stream
matching-server:replies                인게임 서버 -> 매칭 서버 명령 결과 stream
game-results                           인게임 서버 -> 결과 저장 worker stream
operation:{requestId}                  명령 중복 처리 방지용 짧은 TTL 결과
```

방 생성, 참가 예약, 경기 결과처럼 유실되면 안 되는 메시지는 Redis Streams를 사용한다. room directory가 변경됐음을 알리는 비핵심 wake-up에는 Pub/Sub을 사용할 수 있지만, 실제 최신 상태는 항상 Redis key에서 다시 읽는다.

Stream은 재전달될 수 있으므로 모든 명령은 `requestId`를 포함하고 멱등해야 한다. 처리 완료 전에는 `XACK`하지 않는다.

Stream 운영 규칙:

- 모든 stream은 consumer group으로 읽는다. group 이름을 고정한다. 명령은 `cg:game`, 응답은 `cg:match`, 결과는 `cg:result-worker`.
- consumer가 죽어 pending으로 남은 항목은 일정 시간(기본 30초) 뒤 `XAUTOCLAIM`으로 회수한다. 회수된 명령도 멱등 규칙에 따라 안전하게 재처리된다.
- 모든 stream에 `MAXLEN ~` 상한을 건다. 상한이 없으면 소비자 장애가 그대로 Redis 메모리 고갈로 이어진다.
- 결과 stream은 상한에 도달하기 전에 경보를 낸다. 잘려나가면 전적이 사라진다.
- 키 이름에는 환경 prefix를 강제한다. prefix를 붙이지 않는 직접 키 접근을 코드에서 금지한다.

Redis 장애 시 정책:

- 진행 중인 방은 로컬 메모리에서 계속 실행한다.
- 신규 방 생성과 참가 배정은 중단한다.
- 인게임 서버는 결과를 메모리 outbox에 보관하고 Redis 복구 후 재전송한다.
- Redis 장애가 길어져 outbox 한도를 넘으면 명확한 오류를 기록하고 신규 게임 시작을 막는다.

## 10. 방 상태 머신

```text
ALLOCATING -> WAITING -> COUNTDOWN -> PLAYING -> POST_GAME
                  ^                                   |
                  └───────────────────────────────────┘
                       결과 표시 후 자동 복귀

WAITING -> CLOSED       마지막 인원이 나갔을 때
```

- `ALLOCATING`: 방 생성 중이며 외부 목록에 아직 노출하지 않는다.
- `WAITING`: 대기실. 참가, 퇴장, 맵 선택, 스킬 세팅이 가능하다. 준비 상태 개념은 없다.
- `COUNTDOWN`: 참가 인원과 맵을 잠그고 게임 데이터를 초기화한다.
- `PLAYING`: 게임 루프가 활성화된다.
- `POST_GAME`: 결과를 표시한다. 제한 시간이 지나면 자동으로 `WAITING`으로 돌아간다.
- `CLOSED`: Redis room directory에서 제거하고 메모리를 해제한다.

방은 경기가 끝났다는 이유로 닫히지 않는다. 방이 닫히는 유일한 조건은 인원이 0이 되는 것이다.

상태 변경은 모두 인게임 서버가 검증한다. 클라이언트가 직접 상태를 지정할 수 없다.

상태별 추가 규칙:

- 방장이 나가면 남은 인원 중 가장 먼저 들어온 사람에게 방장을 이양하고 `lobby.hostChanged`를 보낸다. 레거시와 같은 규칙이다.
- 방장이 직접 다른 참가자를 지목해 이양할 수도 있다. 레거시의 `pass owner`에 해당한다.
- 참가자는 `WAITING`에서 빈 1~8번 슬롯을 직접 선택해 자신의 번호를 바꿀 수 있다. 점유된 슬롯으로는 이동할 수 없다. 서버는 요청자가 자기 번호만 바꾸는지, 슬롯 범위와 빈자리 여부를 검증한다.
- `WAITING`에서 인원이 0이 되면 즉시 `CLOSED`로 간다. 빈 방이 목록에 남아 있으면 안 된다.
- `COUNTDOWN` 진입 시 참가자 명단, 맵, 규칙 설정 snapshot을 잠근다. 이후 참가 요청은 `ROOM_LOCKED`로 거절한다.
- `PLAYING` 중 끊긴 자리는 재접속 유예 동안 예약 상태로 유지되며 다른 사용자에게 배정되지 않는다.
- `POST_GAME`은 제한 시간(기본 30초)을 갖고, 시간이 지나면 `WAITING`으로 돌아간다.
- 재경기에 별도 합의 절차를 두지 않는다. 경기가 끝나면 결과를 보여준 뒤 같은 명단, 같은 방장으로 대기실에 돌아온다. 다음 경기는 방장이 다시 시작한다. 레거시 `EndGame`과 같은 동작이다.
- 준비 상태 개념은 없다. 오조작 방지는 아래 시작 잠금과 카운트다운이 담당한다.
- 모든 상태에 최대 체류 시간을 둔다. 어떤 이유로든 상태 전이가 멈춘 방이 프로세스 자원을 영구히 붙잡고 있으면 안 된다.

### 10.1 시작 잠금

새로 들어온 사람이 스킬을 고를 새도 없이 경기에 끌려 들어가면 안 된다. 맵이 바뀌면 기존 인원도 로드아웃을 다시 고르고 싶을 수 있다. 그래서 특정 사건이 일어나면 일정 시간 동안 방장의 시작 버튼을 잠근다.

방은 `startUnlocksAt` 시각 하나를 들고 있고, 다음 사건에서 이 값을 뒤로 민다. 이미 더 뒤에 있으면 그대로 둔다.

```ts
startUnlocksAt = Math.max(startUnlocksAt, now + lockMs);
```

| 사건 | 기본 잠금 | 이유 |
| --- | --- | --- |
| 참가 | 5초 | 들어온 사람이 로드아웃을 고를 시간 |
| 맵 변경 | 10초 | 맵에 따라 스킬 선택이 달라진다 |

- 잠금 여부는 서버가 판정한다. 클라이언트의 버튼 비활성화는 표시일 뿐이고, 잠금 중 도착한 `lobby.start`는 `START_LOCKED`로 거절한다. 버튼을 우회해 요청을 보내는 것으로 잠금을 넘길 수 없어야 한다.
- 퇴장은 잠금을 걸지 않는다. 나가는 사람 때문에 남은 사람이 기다릴 이유가 없다.
- 잠금은 시작을 막을 뿐 카운트다운을 취소하지 않는다. `COUNTDOWN`에 들어간 뒤에는 참가 자체가 `ROOM_LOCKED`로 막히므로 잠금이 개입할 일이 없다.
- 남은 시간은 `lobby.state`의 `startLockMs`로 내려보낸다. 클라이언트는 이 값으로 카운트다운을 표시한다.

### 10.2 시작 잠금 남용 방지

참가가 잠금을 건다는 것은, 계속 들어왔다 나가면 방장이 영원히 시작할 수 없다는 뜻이다. 이건 실제로 성립하는 공격이므로 잠금 규칙 자체에 상한을 둔다.

- **누적 상한**: 참가로 인한 잠금은 최근 60초 동안 합계 15초를 넘길 수 없다. 정상적인 한 명의 참가는 항상 5초를 받지만, 같은 창에서 네 번째 참가부터는 잠금을 걸지 못한다.
- **맵 변경 잠금은 상한에서 제외한다.** 맵 변경은 방장만 할 수 있고, 방장이 자기 방의 시작을 막을 이유가 없다.
- **강퇴당한 사용자는 그 방이 살아 있는 동안 재참가할 수 없다.** 방 단위 차단 목록을 인게임 서버 메모리에 둔다. 방장이 문제 인원을 실제로 쫓아낼 수 있어야 잠금 상한이 최후 방어선으로 남는다.
- **방장이 방을 잠글 수 있다.** `WAITING` 중에도 신규 참가를 막는 토글이다. 공개 방에서 괴롭힘을 당할 때 방장이 직접 쓸 수 있는 수단이 필요하다.

위 규칙들은 방 안에서의 방어다. 애초에 반복 참가가 방까지 도달하지 못하게 막는 것은 매칭 서버의 몫이며, 보안 절의 방 참가 남용 방지를 함께 본다.

## 11. 관전

관전자는 경기에 영향을 주지 않고 은신 검열이 없는 스냅샷을 받는 참가자다.

관전자가 되는 경로는 둘이다.

1. 경기 중 탈락한 플레이어. 탈락 즉시 관전으로 전환한다.
2. 경기가 이미 시작된 방에 참가한 사람. 기본 상태는 대기실이며, 그대로 스킬 세팅을 만지고 있어도 된다. 본인이 관전하기를 누르면 그때부터 관전자가 된다.

규칙:

- 관전 자격은 서버가 판정한다. 클라이언트가 관전 모드를 선언할 수 없다.
- 살아 있는 플레이어에게는 어떤 경우에도 검열 없는 스냅샷을 보내지 않는다. 관전 요청이 와도 상태를 확인해 거절한다. 이 규칙 하나가 뚫리면 시야 시스템 전체가 무의미해진다.
- 대기실에 있는 사람에게는 게임 스냅샷을 아예 보내지 않는다. 검열본도 보내지 않는다. 관전하기를 누른 뒤부터 전송을 시작한다.
- 관전자는 입력 패킷과 스킬 요청을 보낼 수 없다. 서버는 관전자가 보낸 입력을 무시하고 남용 집계에 포함한다.
- 관전자도 이모지는 사용할 수 있다.
- 관전자에게는 `SELF` 섹션을 보내지 않는다. `docs/ENGINE.md`의 관전 모드 규약과 같다.
- 관전자는 관전을 끄고 대기실 화면으로 돌아갈 수 있다. 이때 스냅샷 전송을 멈춘다.
- `POST_GAME`에서 `WAITING`으로 돌아올 때 탈락자와 관전자를 모두 일반 참가자로 되돌린다. 경기 중에 들어온 사람도 다음 경기부터는 정식 참가자다.

관전은 시야 시스템의 예외 경로다. "누가 검열 없는 스냅샷을 받는가"는 한 곳에서만 판정하고, 스냅샷 인코딩 직전에 그 판정 결과를 참조하는 구조로 만든다. 판정 로직이 여러 곳에 흩어지면 한 곳만 빠뜨려도 시야가 새어나간다.

## 12. WebSocket 전송 규칙

하나의 WebSocket 연결에서 text frame과 binary frame을 구분한다.

### 12.1 바이너리 메시지

고빈도 상태에 사용한다.

- 클라이언트 -> 서버: 현재 입력 상태
- 서버 -> 클라이언트: 월드 스냅샷
- 필요 시 ping 측정용 애플리케이션 메시지

입력 패킷 초안:

```text
u8  protocolVersion
u8  messageType = INPUT_STATE
u16 inputSequence
u8  movementBits
u8  heldActionBits
```

`movementBits`:

```text
bit0 left
bit1 right
bit2 up
bit3 down
```

서버는 좌우 또는 상하가 동시에 눌렸을 때 해당 축을 0으로 처리하고, 대각선 이동은 정규화한다. 클라이언트가 보낸 좌표, 속도, 이동 거리, 쿨타임은 신뢰하지 않는다.

클라이언트는 입력 변경 즉시 패킷을 보내고, 현재 상태를 설정된 주기로 반복 전송한다. 서버는 sequence가 과거인 입력과 입력 rate limit을 넘는 패킷을 무시한다.

입력 패킷 길이는 6바이트로 고정이다. 길이가 정확히 일치하지 않으면 패킷 전체를 버린다.

`inputSequence`는 `u16`이라 60Hz에서 약 18분마다 한 바퀴 돈다. "과거 입력 무시"를 단순 크기 비교로 구현하면 wrap 시점 이후 모든 입력이 무시된다. 비교는 wrap을 고려한 부호 있는 차이로 하고, 그 함수는 `shared`에 한 벌만 둔다.

서버 스냅샷의 `SELF` 섹션에는 추후 `lastProcessedInputSequence`를 추가한다. 기존 클라이언트가 추가 필드를 건너뛸 수 있도록 섹션 길이 규약을 유지한다.

### 12.2 JSON 메시지

저빈도 명령과 이벤트에 사용한다.

- 대기실 참가, 퇴장
- 방장 및 맵 변경
- 강퇴
- 스킬 사용 요청
- 이모지
- 게임 시작 및 종료
- 술래 변경과 탈락
- 오류 및 요청 거부 사유

```json
{
  "v": 1,
  "type": "player.eliminated",
  "eventId": 183,
  "serverTick": 9401,
  "payload": { "playerId": 4, "by": 1 }
}
```

JSON 이벤트는 연출과 사용자 알림 용도다. 실제 게임 상태 변화는 다음 바이너리 스냅샷에도 반드시 반영한다. 이벤트 하나만 놓쳤다고 클라이언트의 게임 상태가 영구적으로 달라지면 안 된다.

실제 메시지 이름과 payload는 JSON 메시지 카탈로그 절에서 고정한다.

### 12.3 Backpressure

스냅샷은 최신 상태가 중요하므로 느린 클라이언트에 과거 스냅샷을 계속 쌓지 않는다.

델타 스냅샷의 기준은 "그 연결에 마지막으로 보낸 스냅샷"이다. WebSocket은 순서와 도달을 보장하므로 서버가 보내기로 한 프레임은 반드시 도착한다. 기준이 어긋날 수 있는 경우는 서버가 의도적으로 프레임을 건너뛸 때뿐이고, 그때는 누적되어야 하는 변경을 다음 프레임에 합쳐 기준을 유지한다. 시야 검열과 델타 기준이 모두 연결마다 다르므로 스냅샷 인코딩은 방 단위가 아니라 연결 단위로 수행한다.

- socket buffer가 soft limit을 넘으면 교체 가능한 위치 스냅샷을 생략한다.
- 타일 변경처럼 누적되어야 하는 변경은 생략하지 않고 다음 패킷에 합친다.
- 클라이언트가 기준 tick보다 너무 뒤처지면 full snapshot을 보낸다.
- hard limit을 일정 시간 넘으면 연결을 종료한다.
- 작은 바이너리 패킷에는 WebSocket 압축을 사용하지 않는다.

## 13. JSON 메시지 카탈로그

앞 절이 메시지의 성격만 정했다면 이 절은 실제 이름과 payload를 고정한다. 클라이언트 담당자와 서버 담당자가 이 표만 보고 각자 구현할 수 있어야 한다. 타입은 `shared/src/protocol/events.ts`에 둔다.

공통 규칙:

- 모든 메시지는 `v`와 `type`을 갖는다. `type`은 `명사.동사` 형태의 소문자 점 표기다.
- 클라이언트 요청은 `requestId`(연결 안에서만 유효한 증가 정수)를 갖고, 서버는 거부할 때 그 값을 되돌려준다. 어떤 요청이 거부됐는지 클라이언트가 알 수 있어야 한다.
- 서버 이벤트는 연결 안에서 단조 증가하는 `eventId`와 그 시점의 `serverTick`을 갖는다.
- 서버는 클라이언트에 `userId`를 내려보내지 않는다. 방 안에서 사람을 가리키는 값은 항상 방 범위의 `playerId`다. 계정 식별자를 다른 참가자에게 노출할 이유가 없다.
- 서버는 요청에 대해 성공 응답을 따로 보내지 않는다. 성공은 뒤따르는 상태 이벤트나 스냅샷으로 확인한다. 거부만 명시적으로 응답한다.

### 13.1 클라이언트 -> 서버

| type | payload | 허용 상태 | 비고 |
| --- | --- | --- | --- |
| `auth` | `{ ticket }` | 인증 전 | 접속 후 5초 안에 보내야 한다 |
| `lobby.setMap` | `{ mapId }` | WAITING | 방장만 |
| `lobby.kick` | `{ playerId }` | WAITING | 방장만 |
| `lobby.start` | `{}` | WAITING | 방장만. 인원과 시작 잠금을 서버가 검증 |
| `lobby.passHost` | `{ playerId }` | WAITING | 방장만. 레거시 `pass owner` |
| `lobby.setSlot` | `{ slot }` | WAITING | 자신의 번호를 빈 1~8번 슬롯으로만 변경 |
| `lobby.setLocked` | `{ locked: boolean }` | WAITING | 방장만. 신규 참가 차단 토글 |
| `lobby.leave` | `{}` | WAITING, POST_GAME | |
| `lobby.setLoadout` | `{ skills, control }` | WAITING | 경기 중인 방의 대기자도 사용 가능. `control`은 UI 표시용 입력 방식이며 판정에 사용하지 않음 |
| `lobby.spectate` | `{ spectate: boolean }` | PLAYING | 탈락자와 경기 중 참가한 대기자만. 자격은 서버가 판정 |
| `game.useSkill` | `{ slot }` | PLAYING | 관전자는 불가. 쿨타임과 사용 가능 여부는 서버가 판정 |
| `game.emoji` | `{ emojiId }` | WAITING, PLAYING, POST_GAME | 허용 목록 검사 |
| `ping` | `{ clientTime }` | 인증 후 | 응답은 `pong` |

### 13.2 서버 -> 클라이언트

| type | payload | 시점 |
| --- | --- | --- |
| `auth.ok` | `{ playerId, roomId, roomState, role, guest, protocolVersion, rulesVersion, mapBundleHash }` | 티켓 검증 성공 직후 |
| `lobby.state` | `{ hostId, mapId, capacity, startLockMs, players: [{ playerId, slot, nickname, colorIndex, guest, role, control, skills, stats }] }` | 대기실 변경 시 전체 상태. `role`은 `player`, `waiting`, `spectator`. `stats`는 표시 전용 전적 요약이며 게스트는 `null`. `startLockMs`는 시작 버튼이 풀리기까지 남은 시간 |
| `lobby.hostChanged` | `{ hostId }` | 방장 이양 |
| `game.starting` | `{ startsAtTick, countdownMs, mapId, gameplay }` | COUNTDOWN 진입 |
| `game.started` | `{ startTick, taggerId }` | PLAYING 진입 |
| `player.tagged` | `{ playerId, by }` | 술래 변경 |
| `player.eliminated` | `{ playerId, by }` | 탈락 |
| `player.left` | `{ playerId, reason }` | 이탈 또는 유예 만료 |
| `player.reconnecting` | `{ playerId, graceMs }` | 연결 끊김 감지 |
| `spectate.changed` | `{ playerId, spectating }` | 관전 시작 또는 해제 |
| `game.ended` | `{ winnerIds: [playerId, playerId], returnsAt }` | POST_GAME 진입. 최후의 두 명이 공동 승리자이며 `returnsAt`은 대기실 복귀 시각 |
| `error` | `{ requestId, code, retryable }` | 요청 거부 |
| `pong` | `{ clientTime, serverTime, serverTick }` | `ping` 응답 |

`game.starting`의 `gameplay`에는 클라이언트 HUD가 필요한 쿨타임과 지속시간을 담는다. 클라이언트에 같은 상수를 복사하지 않는다는 설정 절의 규칙을 여기서 구현한다.

### 13.3 오류 코드

`error` 메시지의 `code`는 다음 집합으로 고정한다. 클라이언트는 모르는 코드를 만나면 일반 오류 문구로 표시한다.

```text
AUTH_FAILED          티켓 무효, 만료, 재사용, 서버 불일치를 모두 포함
AUTH_TIMEOUT         제한 시간 안에 auth 미수신
PROTOCOL_MISMATCH    프로토콜 또는 map bundle 버전 불일치
NOT_HOST             방장 전용 요청
SPECTATE_DENIED      관전 자격 없음. 살아 있는 플레이어의 관전 요청 포함
START_LOCKED         시작 잠금이 아직 풀리지 않음
SLOT_OCCUPIED        번호 변경 대상 슬롯이 이미 사용 중임
BAD_STATE            현재 방 상태에서 허용되지 않는 요청
INVALID_PAYLOAD      스키마 위반
RATE_LIMITED         요청 빈도 초과
ROOM_CLOSED          방이 종료됨
KICKED               방장 또는 운영에 의해 퇴장
SERVER_SHUTDOWN      프로세스 종료
INTERNAL             그 외
```

`PROTOCOL_MISMATCH`와 `AUTH_FAILED`는 재시도로 해결되지 않으므로 `retryable: false`로 내려 클라이언트가 자동 재접속 루프를 돌지 않게 한다.

close code는 정상 종료 1000, 정책 위반 1008, 크기 초과 1009를 쓰고, 사유는 종료 직전 `error` 메시지로 먼저 전달한다. 브라우저에서 close reason 문자열을 신뢰하기 어렵기 때문이다.

## 14. 게임 루프

권장 초기값은 60Hz 시뮬레이션과 30Hz 스냅샷이다. 모든 값은 설정 파일에서 변경 가능해야 하며 부하 테스트와 실제 플레이 감각으로 확정한다.

인게임 서버 프로세스마다 하나의 scheduler가 활성화된 모든 방을 순회한다. `performance.now()`와 accumulator를 사용한 fixed timestep 방식으로 구현한다.

```text
1. 수신된 최신 입력 상태 확정
2. 맵 timeline의 현재 tick 변경 적용
3. 자기장 inset 계산
4. 스킬과 상태 효과에 따른 목표 속도 계산
5. 모든 플레이어의 후보 위치 계산
6. 벽과 자기장 충돌 해결
7. 플레이어 간 충돌 해결
8. 정적 충돌과 플레이어 충돌을 제한 횟수만큼 반복
9. 술래 접촉과 스킬 판정
10. 쿨타임, 생존 상태, 게임 종료 조건 갱신
11. 이번 tick의 권위 프레임 확정
12. 연결별 시야와 은신 계산
13. 송신 tick이면 연결별 스냅샷 생성
```

11단계의 권위 프레임은 연결을 모르는 단일 상태다. 12단계 이후가 그 프레임에서 연결별 뷰를 파생시킨다. 순서를 뒤집어 "연결을 돌면서 상태를 계산"하는 구조로 만들면 안 된다.

이 경계가 필요한 이유는 두 가지다. 첫째, 관전자와 플레이어가 같은 tick에 대해 서로 다른 뷰를 받는데 원본이 하나여야 둘이 어긋나지 않는다. 둘째, 나중에 리플레이 기록을 붙일 때 이 경계에 소비자를 하나 더 다는 것으로 끝난다. 리플레이는 특정 연결에 실제로 보낸 패킷을 복사해서는 안 된다. 연결마다 검열 내용도, 델타 기준도, backpressure로 생략된 프레임도 다르기 때문이다. 자세한 내용은 `docs/FUTURE.md`를 본다.

한 프레임이 밀렸을 때 catch-up step은 설정된 최대 횟수로 제한한다. 최대 횟수를 넘으면 남은 누적 시간은 버리고 tick은 건너뛰지 않는다. tick은 맵 timeline과 자기장 계산의 기준이므로 tick을 건너뛰면 같은 경기가 서버 부하에 따라 다르게 진행된다. 시간을 버리면 경기가 실제 시간 기준으로 아주 조금 느려질 뿐 게임 내부 일관성은 유지된다.

지속적으로 loop lag가 발생하면 서버를 `draining` 처리해 신규 방을 받지 않는다.

## 15. MapBuilder 연동

MapBuilder가 생성하는 서버 데이터는 게임 서버 build artifact로 포함한다. 런타임에서 CSV를 다시 읽거나 자기장 주변 벽을 매 틱 검색하지 않는다.

현재 생성 데이터:

- `initial_map`: physics grid
- `timeline`: 맵 이벤트와 자기장에 의한 벽 파괴를 합친 tick별 변경
- `start_pos`: 3~8인용 시작 위치
- `barrier_speed`: tick당 자기장 inset 증가량

게임 시작 tick 0에서 `initial_map`을 복사하고, 매 tick `timeline[currentTick]`이 있을 때만 변경을 적용한다. 자기장 사각형은 다음과 같이 O(1)로 계산한다.

```ts
const inset = tick * map.barrierSpeed;
```

MapBuilder의 현재 동작에 따라 별도의 자기장 시작 지연은 두지 않는다.

맵 bundle에는 다음 metadata를 추가한다.

```ts
interface ServerMapBundle {
    schemaVersion: number;
    mapBundleHash: string;
    simulationHz: number;
    tileSize: number;
    maps: Record<string, ServerMap>;
}
```

`simulationHz`가 다르면 같은 timeline이 다른 실제 속도로 재생되므로 게임 서버 설정과 map bundle 값이 다를 때 서버 시작을 실패시킨다. 맵을 빌드한 tick 규칙과 런타임 tick 규칙은 항상 같아야 한다.

## 16. 벽과 자기장 충돌

플레이어는 원, 벽 타일은 axis-aligned box로 취급한다.

- 이동 후보 위치 주변의 타일만 조회한다.
- 원과 타일 AABB의 closest point를 이용해 침투 깊이와 법선을 구한다.
- 축 벽뿐 아니라 모서리 충돌도 같은 방식으로 처리한다.
- 대시처럼 한 tick 이동량이 큰 경우 sub-step 또는 swept circle을 사용한다.
- 자기장은 맵 바깥쪽에서 안쪽으로 줄어드는 단단한 사각형 경계다.
- 자기장이 줄면서 플레이어와 겹치면 가장 가까운 안쪽 유효 위치로 밀어낸다.

충돌 계산 후 좌표는 항상 맵과 자기장 내부의 유효한 값이어야 한다.

## 17. 플레이어 간 충돌과 밀어내기

플레이어끼리는 서로 통과하지 못한다. 모든 플레이어의 후보 위치를 먼저 계산한 뒤 pair collision을 해결해 플레이어 처리 순서에 따른 유불리를 줄인다.

플레이어 수가 최대 8명이므로 초기에는 모든 pair를 검사해도 충분하다. 인원수가 늘어나는 모드가 생기면 spatial hash를 추가한다.

겹친 두 플레이어 A와 B에 대해 다음을 계산한다.

```ts
const approachA = Math.max(0, dot(velocityA, normalFromAToB));
const approachB = Math.max(0, dot(velocityB, normalFromBToA));

const powerA = PUSH_BASE_POWER + approachA * PUSH_SPEED_FACTOR;
const powerB = PUSH_BASE_POWER + approachB * PUSH_SPEED_FACTOR;
```

침투 보정량은 상대 힘에 비례해 나눈다.

```ts
moveA = penetration * powerB / (powerA + powerB);
moveB = penetration * powerA / (powerA + powerB);
```

따라서 빠르게 접근한 플레이어는 덜 밀리고 상대를 더 밀며, 둘 다 정지했거나 같은 속도라면 절반씩 밀린다. `PUSH_BASE_POWER`는 정지 플레이어의 기본 저항으로 작동한다.

플레이어를 밀어낸 뒤 벽과 자기장 충돌을 다시 해결한다. 플레이어가 벽에 끼어 상대를 벽 너머로 밀거나 두 플레이어가 계속 겹치는 문제를 줄이기 위해 정적 충돌과 pair collision을 3~4회 반복한다. 반복 횟수는 설정값으로 둔다.

술래 접촉은 최종 분리된 거리만 보지 않고 해당 tick에서 발생한 collision pair를 기준으로 판정한다. 충돌 해결로 두 원이 정확히 떨어진 뒤 접촉을 놓치는 문제를 방지한다.

반복 계산은 순회 순서에 영향을 받으므로 pair는 항상 `playerId` 오름차순으로 정렬해 처리한다. 결정론 테스트는 같은 빌드와 같은 플랫폼을 전제로 한다. 부동소수 연산은 플랫폼 간 비트 단위 동일성을 보장하지 않으므로 리플레이 검증은 기록한 환경과 같은 환경에서 수행한다.

## 18. 연결 해제와 재접속

연결이 끊긴 즉시 해당 플레이어의 입력을 중립 상태로 바꾼다. 캐릭터가 마지막 입력 방향으로 계속 이동하면 안 된다.

- 기본 재접속 유예: 10초
- 유예 중 플레이어 slot과 게임 상태 유지
- 재접속 성공 시 새 일회용 resume ticket 검증
- full snapshot과 최신 대기실 상태 전송
- 유예 만료 시 게임 규칙에 따라 퇴장 또는 탈락 처리

재접속 경로는 최초 접속과 같다. 클라이언트는 인게임 서버에 바로 붙지 않고 매칭 서버에 재접속을 요청해 `RESERVE_RESUME`으로 새 티켓을 받는다. 기존 티켓은 이미 소모됐고, 티켓을 재사용 가능하게 만들면 유출된 티켓이 유예 시간 동안 계속 유효해진다.

유예 중인 자리는 예약 상태이므로 다른 사용자에게 배정되지 않는다. 유예 중 같은 계정으로 새 연결이 들어오면 기존 유예를 끝내고 새 연결로 대체한다.

서버 프로세스 자체가 종료된 경우에는 재접속을 지원하지 않는다. 클라이언트는 매칭 화면으로 돌아가며, 추후 방 migration을 구현할 때 별도 설계한다.

## 19. 선택 가능한 클라이언트 예측

서버 권위 모델은 예측 옵션과 무관하게 유지한다. 서버는 언제나 실제 위치와 충돌 결과를 결정한다.

클라이언트 설정에는 다음 두 모드를 둘 수 있다.

```ts
type LocalMovementMode = 'server-only' | 'predict-self';
```

- `server-only`: 자기 캐릭터도 서버 스냅샷을 보간해 표시한다.
- `predict-self`: 자기 입력으로 화면상 위치만 먼저 움직이고 서버 위치로 부드럽게 보정한다.

`predict-self` 구현을 위해 입력 sequence와 아직 서버가 처리하지 않은 입력 history를 보관한다. 서버 스냅샷의 `lastProcessedInputSequence`를 기준으로 이미 처리된 입력을 제거하고 나머지를 다시 적용한다.

벽, 자기장, 보이지 않는 플레이어 때문에 예측이 틀릴 수 있으므로 예측 결과는 게임 판정이나 다른 플레이어에게 절대 전송하지 않는다. 초기 기본값은 실제 플레이 화면 비교 후 결정한다.

## 20. 설정 파일 분리

밸런스 수치는 환경 변수에 흩어놓지 않고 버전 관리되는 타입 안전한 설정 파일에 둔다.

```text
server-game/src/config/
  gameplay.ts       이동, 반지름, 밀기, 스킬, 쿨타임, 게임 종료 조건
  network.ts        simulation Hz, snapshot Hz, rate limit, buffer limit, 재접속 시간, 시작 잠금 시간
  infrastructure.ts 포트, Redis 주소, serverId, public route 등 환경 변수 파싱
```

예시:

```ts
export const GAMEPLAY = Object.freeze({
    PLAYER_RADIUS_PX: 102,
    BASE_MOVE_SPEED_PX_PER_SEC: 480,
    PUSH_BASE_POWER: 1,
    PUSH_SPEED_FACTOR: 0.01,
    PLAYER_COLLISION_ITERATIONS: 4,
    MAX_SUBSTEP_DISTANCE_PX: 48,
    TAGGER_CHANGE_COOLDOWN_MS: 20_000,
});
```

위 숫자는 구조를 보여주기 위한 임시값이며 플레이 테스트 전에는 확정값으로 간주하지 않는다.

밸런스 파일이 바뀌면 `rulesVersion`도 바뀌어야 한다. 진행 중인 방의 규칙은 생성 시점의 설정 snapshot을 사용하고, 프로세스 재시작 없이 게임 중간에 전역 값이 바뀌지 않게 한다.

클라이언트 HUD에 필요한 쿨타임과 지속시간은 클라이언트에 같은 상수를 복사하지 않고 게임 시작 metadata와 스냅샷으로 전달한다.

## 21. 권장 코드 구조

```text
server-game/src/
  main.ts
  config/
    gameplay.ts
    network.ts
    infrastructure.ts
  transport/
    game-transport.ts
    ws-transport.ts
  redis/
    keys.ts
    registry.ts
    command-consumer.ts
    result-outbox.ts
  gateway/
    connection-manager.ts
    ticket-auth.ts
    ticket-store.ts
    rate-limit.ts
    message-router.ts
  rooms/
    room.ts
    room-manager.ts
    lobby-state.ts
    room-state.ts
  simulation/
    scheduler.ts
    world.ts
    movement.ts
    static-collision.ts
    player-collision.ts
    storm.ts
    skills.ts
    visibility.ts
  protocol/
    input-decoder.ts
    snapshot-encoder.ts
    json-events.ts
  replay/
    recorder.ts
    replay-store.ts
  maps/
    map-loader.ts
    generated/
```

`shared`는 다음과 같이 나눈다. 두 서버와 클라이언트가 모두 여기에 의존한다.

```text
shared/src/
  protocol/
    constants.ts      프로토콜 버전, 섹션 타입, 플래그, 이펙트 비트 순서
    snapshot.ts       encoder/decoder 공통부
    input.ts          입력 패킷 encode/decode, sequence wrap 비교
    events.ts         JSON 메시지 타입과 오류 코드
  control/
    commands.ts       CREATE_ROOM 등 명령과 응답 타입
    results.ts        경기 결과 메시지 타입
  visibility/
    types.ts          입출력 계약 (S 단계에서 확정)
    core.ts           시야 판정 순수 함수 (C 단계에서 구현)
    version.ts        VISIBILITY_CORE_VERSION
```

`types.ts`와 `version.ts`는 계약이라 S에서 고정하고, 실제 판정 알고리즘 `core.ts`는 시뮬레이션과
함께 C에서 채운다. 인터페이스를 먼저 박아두는 이유는 그 경계가 나중에 리플레이가 붙을 자리이기 때문이다.

시야 코어를 `server-game`이 아니라 `shared`에 두는 것은 의도적이다.

- 서버는 스냅샷 검열에, 리플레이 플레이어는 과거 경기의 개인 시점 재구성에 같은 함수를 쓴다. 두 벌로 관리하면 시간이 지나며 결과가 갈라지고, 그때부터 리플레이는 "그 사람이 실제로 본 화면"이 아니게 된다.
- `ENGINE.md`의 튜토리얼 모드는 서버 없이 로컬에서 스냅샷을 만든다. 시야 판정이 서버 안에만 있으면 튜토리얼에서 시야를 재현할 수 없다.
- 시야 알고리즘은 비밀이 아니다. 클라이언트가 알아도 위험하지 않은 이유는, 애초에 보이지 않는 플레이어의 좌표를 클라이언트가 받지 못하기 때문이다. 보안은 알고리즘 비공개가 아니라 데이터 미전송에서 나온다.

`core.ts`는 소켓, Phaser, 방 객체를 모르는 순수 함수여야 한다. 입력은 권위 월드 상태와 `viewerId`, 출력은 보이는 플레이어 집합과 타일 alpha다. `VISIBILITY_CORE_VERSION`은 판정 결과가 달라지는 변경마다 올리고 경기 결과에 함께 기록한다.

WebSocket 구현 교체를 위해 게임 로직은 `GameTransport` 인터페이스에만 의존한다. 첫 구현은 `ws`로 만들고 실제 목표 부하 테스트에서 CPU, 메모리, event loop lag가 문제가 될 때 uWebSockets.js 구현을 추가할 수 있다.

시뮬레이션은 소켓과 Redis를 알지 않는다. `simulation/`은 방 상태와 입력 배열을 받아 tick을 진행하는 순수 계산 계층이고, 전송과 저장은 바깥에서 처리한다. 이 경계 덕분에 시뮬레이션과 전송 계층을 서로 다른 사람이 동시에 만들 수 있고, 시뮬레이션 단독 결정론 테스트가 가능해진다.

## 22. 기존 바이너리 프로토콜 정리 항목

서버 구현 전에 `docs/ENGINE.md`와 클라이언트 protocol 코드를 다음과 같이 맞춘다.

0. (반영 완료 2026-08-23) 아래 1~7의 프로토콜 정리는 `shared` 패키지 구축과 함께 끝났다. 남은 것은 8번뿐이다.
1. (반영 완료) 플레이어 기본 레코드 크기를 실제 코드 기준 10바이트로 수정했다.
2. (반영 완료) `emojiId` 존재 조건을 코드와 같은 flags bit2 (`0x04`)로 통일했다. `ENGINE.md`가 같은 표 안에서 bit3과 bit2를 동시에 적고 있었다.
3. (반영 완료) 저빈도 `EVENTS` 섹션을 JSON `player.blinked`로 옮기고 `0x08`을 폐기 번호로 표시했다.
4. (반영 완료) 스냅샷 헤더의 tick을 `u32`로 올렸다. 입력 패킷의 `inputSequence`는 `u16`을 유지하고 `shared`의 `compareSequence`를 쓴다.
5. (반영 완료) protocol 상수, 타입, encoder/decoder를 `shared`로 옮겼다. 클라이언트의 `game/protocol/`은 삭제됐고 `game/index.ts`가 `shared`를 다시 내보낸다.
6. (반영 완료) 모든 decoder가 section length와 실제 payload 길이를 검증한다. count가 payload보다 큰 조작 패킷에 회귀 테스트가 붙어 있다.
7. (반영 완료) 입력 decoder는 길이가 정확히 6바이트일 때만 처리한다. 서버와 클라이언트가 같은 함수를 쓴다.
8. 스냅샷 인코딩 대상은 연결이다. `shared`의 encoder는 "이 연결이 볼 수 있는 상태"를 입력으로 받고, 무엇을 보여줄지 고르는 판단은 시야 계산이 담당한다. encoder가 검열 판단을 하지 않게 경계를 지킨다.

## 23. 구현 순서

0. `sessions` 테이블과 `users` 계정 상태 컬럼 마이그레이션, 세션 저장소를 Redis에서 PostgreSQL로 이전
1. `shared`에 바이너리 프로토콜, 제어 명령, JSON 이벤트, 오류 코드 타입 정의
2. 인게임 서버 설정 구조와 map loader 구현
3. 단일 방 lobby 및 WebSocket 연결 구현
4. 티켓 인증과 연결 보호(Origin 검사, 인증 타임아웃, 프레임 크기와 빈도 제한) 구현
5. fixed timestep 이동과 벽/자기장 충돌 구현
6. 플레이어 간 밀기와 술래 접촉 구현
7. 바이너리 입력 및 스냅샷 연결
8. 시야 코어를 `shared`에 순수 함수로 구현하고 수풀, 연막, 스킬 연결
9. Redis registry, 방 projection, 배정 command 구현
10. 매칭 서버 room API와 인게임 서버 배정 연결
11. 경기 결과 stream, 전적 저장, `matchId` unique 제약 추가
12. 재접속, backpressure, draining 구현
13. 결정론적 simulation test와 가짜 클라이언트 부하 테스트
14. 클라이언트 예측 on/off 비교 구현
15. Redis 인증과 ACL 적용, Redis/PostgreSQL 포트 비노출 전환
16. Docker 이미지, reverse proxy service discovery, 로컬 compose 구성

Docker는 마지막 단계지만, 그 전부터 서버가 파일 경로나 localhost에 의존하지 않도록 인프라 값은 `infrastructure.ts`에서 환경 변수로 주입한다.

## 24. 미래 기능 대비

문서는 시제로 나뉜다. 이 문서가 지금 만드는 것, `docs/REPLAY.md`가 다음에 만드는 것, `docs/FUTURE.md`가 언젠가 만들 수도 있는 것이다.

리플레이는 구상에서 설계로 옮겼다. 게임 루프와 시야 코어에 물려 있어 코어와 분리해서 설계할 수 없고, 무엇보다 **결정론적 경기 기록이 시뮬레이션 회귀 테스트의 입력**이라 사용자에게 공개하기 한참 전부터 개발에 쓰인다. 자세한 것은 `docs/REPLAY.md`를 본다.

운영자 페이지 UI, 링크 공유, 파일 서명, 유료 보관은 옮기지 않았다. 실제 사용자와 운영 인력이 생긴 뒤의 문제이고, 지금 설계해봐야 그때 가서 다시 쓴다.

이 문서에서 지금 반영하는 것:

| 항목 | 반영 위치 | 나중에 하면 생기는 비용 |
| --- | --- | --- |
| 시야 코어를 `shared`의 순수 함수로 분리하고 버전을 매김 | 권장 코드 구조 | 서버와 리플레이가 시야 코드를 두 벌로 갖게 되고, 갈라지는 순간 과거 리플레이의 개인 시점이 틀려진다 |
| 게임 루프의 권위 프레임 경계 | 게임 루프 | 연결별 인코딩과 상태 계산이 섞이면 리플레이 기록을 붙일 자리가 없고, 관전자 뷰와 플레이어 뷰가 어긋난다 |
| 경기 결과의 버전 스탬프와 당시 닉네임, `playerId` | 경기 결과 메시지 | 소급 불가. 컬럼을 추가해도 그 이전 경기는 영원히 빈다 |
| `matches` / `match_participants` 테이블 분리 | 경기 결과 메시지 | `stats` jsonb만으로는 경기 단위 조사와 재집계가 불가능하다 |
| 세션의 IP를 HMAC과 암호화 원본으로 분리 | 세션 관리 | 이미 쌓인 원본 IP를 소급 처리해야 하고, 그 사이 보관 기간을 넘긴 개인정보가 남는다 |
| 위반 신호의 단일 방출 지점 | 메시지 남용 방지 | 감지 코드 수십 곳을 찾아다니며 고쳐야 한다 |
| 결과 메시지의 `replay` 필드와 `replay/` 디렉터리 경계 | 경기 결과 메시지, 권장 코드 구조 | 결과 계약을 나중에 바꾸면 매칭 서버와 인게임 서버를 같이 고쳐야 한다 |

설계는 끝났지만 이번 구현 범위가 아닌 것 (`docs/REPLAY.md`):

- `ReplayRecorder` 구현, chunk와 keyframe 직렬화, `ReplayStore`
- 웹 리플레이 플레이어와 개인 시점 재구성
- `matches`/`replays`/`reports`/`sanctions` 테이블과 보존 정책
- 신고 접수와 보존 hold

설계도 하지 않는 것 (`docs/FUTURE.md`):

- `.switchreplay` 내보내기와 전자서명
- 리플레이 링크 공유, 만료, 취소
- 운영자 페이지 UI, 역할 분리, 승인 절차
- 안티치트 신호 저장과 통계 탐지
- 유료 장기 보관과 분석

리플레이 기록은 권위 프레임 경계에 소비자를 하나 더 붙이는 작업이라, 나중에 만들어도 게임 루프를 다시 건드리지 않는다.

## 25. 테스트 기준

- 동일한 초기 상태와 입력 기록은 동일한 게임 결과를 만든다.
- 잘못된 좌표나 속도를 클라이언트가 보낼 방법이 없다.
- 입력 sequence 역전과 과도한 입력을 무시한다.
- 플레이어가 벽, 자기장, 다른 플레이어를 통과하지 않는다.
- 자기장 tick과 MapBuilder timeline이 정확히 일치한다.
- 느린 클라이언트가 다른 클라이언트나 서버 루프를 지연시키지 않는다.
- Redis 중단 중에도 진행 중인 방의 게임 루프는 유지된다.
- draining 서버에는 신규 방이 배정되지 않는다.
- 재접속 시 10초 이내에는 같은 slot과 상태를 복원한다.
- 프로토콜 또는 map bundle 버전이 다른 클라이언트의 접속을 명확히 거부한다.

보안 기준:

- 다른 방 또는 다른 서버의 티켓으로 접속할 수 없다.
- 이미 사용한 티켓과 만료된 티켓이 거절되고, 실패 사유가 응답으로 구분되지 않는다.
- 허용 목록에 없는 `Origin`의 WebSocket upgrade가 거절된다.
- 인증 메시지를 보내지 않는 연결이 제한 시간 안에 정리된다.
- 방장 전용 요청을 다른 참가자가 보내면 거절된다.
- 클라이언트가 보낸 신원 필드가 서버 어디에서도 사용되지 않는다.
- 프레임 크기와 메시지 빈도 상한을 넘는 연결이 종료된다.
- 매칭 서버가 발급하지 않은 `matchId`의 경기 결과가 저장되지 않는다.
- 같은 사용자가 두 방에 동시에 배정되지 않는다.
- 비공개 방의 존재 여부가 오류 응답으로 노출되지 않는다.
- 살아 있는 플레이어가 검열 없는 스냅샷을 받을 수 없다.
- 대기실에 있는 사람에게 게임 스냅샷이 전송되지 않는다.
- 관전자가 보낸 입력 패킷과 스킬 요청이 게임에 영향을 주지 않는다.
- 게스트의 경기 기록이 저장되지 않고, 게스트가 닉네임을 지정할 수 없다.
- 시작 잠금 중 도착한 `lobby.start`가 거절된다. 클라이언트 버튼 상태와 무관하게 막힌다.
- 참가를 반복해도 잠금 누적 상한을 넘겨 시작을 무한히 지연시킬 수 없다.
- 같은 방을 나간 직후 재참가가 쿨다운으로 거절된다.
- 강퇴당한 사용자가 같은 방에 다시 들어올 수 없다.
- 게스트가 신원을 새로 발급받아도 IP 단위 참가 제한을 우회할 수 없다.
- 시야 코어가 소켓, Phaser, 방 객체를 import 하지 않는다. 같은 입력에 같은 결과를 낸다.
- 권위 프레임이 연결 수와 무관하게 동일하다. 관전자가 붙거나 떨어져도 플레이어가 받는 내용이 달라지지 않는다.
- 경기 결과에 버전 스탬프와 당시 닉네임이 빠짐없이 들어간다.
- 세션 테이블에 원본 IP가 평문으로 남지 않는다.
- 리플레이 기록이 실패해도 경기가 정상 진행되고 결과가 저장된다.

부하 기준:

- 8인 풀방 하나에서 tick 처리 시간과 loop lag를 측정한다.
- 방 수를 늘려가며 목표 tick rate가 무너지는 지점을 찾고, 그 절반을 프로세스당 방 수 상한으로 잡는다.
- 이 측정 전에는 `draining` 임계값과 연결 상한을 확정하지 않는다.

## 26. 작업 분담 기준

이 문서를 보고 여러 사람이 동시에 작업하기 위한 경계다. 각 묶음은 다른 묶음의 구현이 끝나기를 기다리지 않아도 되도록 나눴다.

먼저 고정해야 하는 것은 `shared` 패키지다. 아래 모든 묶음이 여기에 의존하므로 이것만 먼저 합의하고 병합한다.

| 묶음 | 범위 | 의존 계약 | 산출물 |
| --- | --- | --- | --- |
| S. 공유 계약 | 바이너리 프로토콜 상수와 encoder/decoder, 제어 명령 타입, JSON 이벤트 타입, 오류 코드, 시야 코어 인터페이스와 버전 | 없음 | `shared/src/` |
| A. 매칭 서버 | 방 API, 세션 테이블 이전, 인증 적용, 게스트 신원 발급, 서버 선택, 명령 발행과 응답 수신, 결과 저장, 계정 상태 검사 | 제어 명령 계약, 결과 메시지 | `server-match/` |
| B. 인게임 서버 골격 | 프로세스 부팅, 설정 3분할, map loader, WebSocket 전송, 티켓 인증, 연결 관리, backpressure | 티켓 규격, JSON 카탈로그 | `server-game/src/{config,transport,gateway,maps}` |
| C. 시뮬레이션 | 고정 timestep 루프, 이동, 벽과 자기장 충돌, 플레이어 충돌, 술래 판정, 스킬, 시야 | 설정 파일 형태, map bundle 형태 | `server-game/src/simulation` |
| D. 방과 대기실 | 방 상태 머신, 대기실, 방장, 시작 잠금, 시작 검증, 대기실 복귀, 관전 자격 판정, 재접속 유예 | JSON 카탈로그, 제어 명령 계약 | `server-game/src/rooms` |
| E. Redis 제어 평면 | registry, heartbeat, room projection, command consumer, result outbox, ACL과 키 prefix | 제어 명령 계약 | `server-game/src/redis`, `server-match/src/redis` |
| F. 클라이언트 연결 | 방 API 연동, WebSocket 접속과 티켓 전송, 스냅샷을 엔진에 연결, 대기실 UI 상태 | JSON 카탈로그, 바이너리 프로토콜 | `client/src/` |
| G. 리플레이 | recorder, chunk 직렬화, store, 로컬 재생 도구 | 권위 프레임 경계, 시야 코어, 결과 메시지 | `server-game/src/replay` |

G는 코어가 돌기 시작한 뒤 착수한다. 다만 3~5단계(recorder, 직렬화, 로컬 재생 도구)까지는 사용자 기능이 아니라 **시뮬레이션 디버깅 도구**라서, C가 어려워지는 시점에 먼저 당겨올 가치가 있다.

병렬 작업 규칙:

- C는 전송 계층 없이 단독 테스트가 가능해야 한다. 시뮬레이션은 `Room` 객체와 입력 배열만 받아 tick을 진행하고, 소켓을 직접 알지 않는다. 이 경계를 지켜야 B와 C를 동시에 만들 수 있다.
- B와 D는 `GameTransport` 인터페이스를 사이에 두고 나뉜다. D는 소켓 구현을 모르고 "이 연결에 이 메시지를 보내라"만 호출한다.
- A와 E는 Redis 키 이름과 명령 payload가 고정되면 서로 독립적이다. A 담당자는 인게임 서버가 없어도 가짜 consumer로 개발할 수 있고, E 담당자는 매칭 서버 없이 명령을 직접 넣어 테스트할 수 있다.
- F는 서버가 없어도 기존 `EngineSandboxPage`의 가짜 스냅샷 생성기로 작업할 수 있다. 실제 서버 연결은 B가 티켓 인증까지 끝난 뒤에 붙인다.
- 계약 파일(`shared/src/`)을 바꾸는 커밋은 다른 변경과 섞지 않는다. 어느 묶음이 영향을 받는지 리뷰에서 바로 보여야 한다.

## 27. 미결 사항

구현 전에 결정이 필요한 항목이다. 결정되면 해당 절에 반영하고 여기서 지운다.

현재 남은 미결 항목은 없다.

결정된 항목:

- 세션은 PostgreSQL `sessions` 테이블에 둔다. 다중 기기 로그인을 허용하고 계정 관리 화면에서 기기별 로그아웃을 제공한다.

- 게스트 접속 허용. 닉네임은 서버가 `Guest_` + 난수로 지정하고 전적은 저장하지 않는다.
- 매칭 서버는 단일 프로세스로 운영한다.
- 방장 이양은 남은 인원 중 가장 먼저 들어온 사람. 방장이 직접 지목할 수도 있다.
- 재경기는 별도 합의 없이 대기실 복귀. 명단과 방장을 유지한다.
- 관전은 탈락자와 경기 중 참가한 대기자가 선택할 수 있다.
- 준비 시스템은 두지 않는다. 대신 참가와 맵 변경 시 시작 잠금이 걸리고, 반복 참가로 잠금을 남용하는 것은 누적 상한과 매칭 서버의 재참가 쿨다운으로 막는다.
- 재접속은 매칭 서버를 거쳐 `RESERVE_RESUME`으로 새 티켓을 받는다. 인게임 서버가 JWT를 검증하지 않는다는 원칙을 지키기 위해서다.
- 부하 상한은 추정하지 않고 8인 풀방 측정으로 정한다.
