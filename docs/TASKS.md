# swITch 작업 분담

Claude와 codex가 같은 워킹 트리에서 동시에 작업한다. 누가 무엇을 맡는지와 그때 읽을 문서를 정리한다.

묶음 정의는 `docs/SERVER_ARCHITECTURE.md`의 작업 분담 기준 절에 있다.

## 개발 방식

기능 구현을 먼저 하고, 취약점과 오류 점검은 나중에 한 번에 돈다. 공개 서비스가 아니라 가능한 방식이다.
다만 나중에 되돌리기 비싼 것 — 티켓 규격, IP 저장 형태, 경기 결과의 버전 스탬프 — 은 처음부터 문서대로
넣는다. 소급이 안 되는 값들이다.

## 파일 소유

| 경로 | 소유 |
| --- | --- |
| `shared/` | Claude. 다른 세션은 **읽기만** |
| `server-game/src/simulation/` | Claude |
| `server-game/src/config/` | 공유. **값을 추가해야 하면 먼저 알린다** |
| `server-game/src/{maps,transport,gateway,rooms,redis}/` | codex |
| `server-match/` | codex |
| `client/` | 사용자 |
| `docs/` | 누구든. 계약을 바꿀 때는 문서를 먼저 고친다 |

`config/`의 세 파일(gameplay, network, infrastructure)은 이미 채워져 있다. 양쪽이 같은 파일을 동시에
고칠 유일한 지점이라 새 상수가 필요하면 임의로 넣지 않는다.

---

## Claude가 할 것

| # | 작업 | 모델 | 상태 |
| --- | --- | --- | --- |
| S | 공유 계약 | — | 완료 (b6dec64) |
| C | 시뮬레이션·시야·스킬 | — | 완료 (b6dec64) |
| 조립 | `game/` 계층과 `main.ts` | — | 완료 (3c86ea4, 96c3646) |
| X | 실제 경기 한 판 굴려보기 | Sonnet 5 | 완료 (2026-08-24) — 발견한 버그 전부 아래 기록 |
| G | 리플레이 recorder와 로컬 재생 도구 | Sonnet 5 | 완료 (2026-08-24) — 상세는 아래 |
| **R** | **보안·오류 점검 라운드** | **Opus 5** | **다음 작업(마지막)** |

### X. 실제 경기 한 판 굴려보기 — 완료

**아무도 이 게임을 아직 플레이해 본 적이 없다.** 단위 테스트 130개가 통과하고 서버도 기동되지만,
브라우저 둘을 붙여 방을 만들고 경기를 끝까지 돌려본 적은 없다. **G와 R보다 이게 먼저다.**
검증되지 않은 것 위에 리플레이를 얹으면 틀린 것을 기록하게 되고, 무엇을 점검해야 하는지도 모른다.

목표는 이 한 줄이다.

```text
로그인 -> 방 생성 -> 다른 브라우저로 참가 -> 시작 -> 서로 움직이는 게 보임
      -> 경기 종료 -> 대기실 복귀 -> 결과가 DB에 남음
```

여기서 나오는 버그가 지금 남은 진짜 작업이다. 계층 사이의 조립은 단위 테스트가 잡지 못한다.

띄우는 법:

```bash
npm run db:up
npm run shared:build && npm run game:build
```

인게임 서버는 `GAME_SERVER_ID`와 `GAME_MAP_BUNDLE`(절대경로)이 필요하다. cwd가 `server-game/`이라
상대경로는 어긋난다. `.env.example`에 나머지 변수가 있다.

### G. 리플레이 — 완료

`docs/REPLAY.md` 12절의 3~6번(레코더, chunk/파일 형식과 `local` store, 로컬 재생 도구, 결과 메시지 연결)까지 구현했다.
7번(웹 리플레이 플레이어)부터는 클라이언트 소유라 이 작업 범위 밖이다.

**추가한 것**

- `server-game/src/replay/format.ts` — 컨테이너 파일 형식(magic/manifest/chunk index/gzip chunk). chunk 안은 프레임·시야 bitmask·이벤트 세 트랙이 같은 경계를 공유한다. 파서는 신뢰 못 하는 입력이라 가정하고 chunk 수, 압축 해제 크기, offset을 매번 검증한다.
- `server-game/src/replay/recorder.ts` — `ReplayRecorder` 계약, `NullReplayRecorder`(꺼짐), `MemoryReplayRecorder`(경기 전체를 메모리에 쌓았다가 `finish()`에서 한 번에 저장 — 5분 경기 원본이 약 1MB라 스트리밍할 이유가 없었다). 경기 단위·프로세스 단위 spool 상한과 저장 실패 시 `abort` 경로가 있다. 기록 실패는 항상 경기 결과 자체는 살리고 `replay: null`만 만든다.
- `server-game/src/replay/replay-store.ts` — `local` `ReplayStore` (파일시스템, range read 지원, key 검증으로 경로 조작 차단). `s3`는 아직 없다.
- `server-game/src/replay/cli.ts` — 로컬 재생/점검 도구(`npm run replay:inspect -w server-game -- <file> [--verify|--tick N|--dump-json out.json]`). 그래픽 플레이어가 아니라 텍스트 기반 디버깅 도구다 — 웹 플레이어는 사용자 공개용(7번)이라 범위 밖.
- `server-game/src/game/session-recorder.ts` — `GameSession`과 레코더 사이. keyframe 주기(2초=60프레임) 판단, 검열 없는 `unfiltered` 인코딩, 뷰어별 시야 bitmask 계산이 여기 있다.
- `GameSession`에 연결: 스냅샷 tick마다 기록하고, 경기 종료 tick은 스냅샷 주기와 안 맞아도 항상 keyframe으로 강제 기록한다. `#finish()`가 `recorder.finish()`를 기다린 뒤(로컬 파일 쓰기라 게임 루프를 막을 만큼 오래 걸리지 않는다) 결과 메시지의 `replay` 필드를 채운다 — 그래서 `match-result.test.ts`의 `session.step()` 직후 동기 단언이 깨져 `await`로 바꿨다(의도된 변경).
- `main.ts`가 `REPLAY_ENABLED`/`REPLAY_STORE`/`REPLAY_LOCAL_DIR`로 조립한다. `.env.example`도 기본 `REPLAY_ENABLED=true`로 바꿨다(로컬 개발 기본 켬).

**검증**: server-game 신규 테스트(format/recorder/replay-store/session-recorder) + 기존 스위트 전체 119개 통과, `npm run build`/`typecheck` 통과, 실제 recorder→저장→CLI(`--verify`/`--tick`/`--dump-json`) 왕복을 스크립트로 직접 실행해 확인. 실 서버로 3인 경기를 굴려 리플레이 파일이 실제로 남는지는 아직 안 해봤다 — R 라운드나 다음 실경기 점검에서 확인이 필요하다.

**R 라운드에서 볼 것 (여기서 발견했지만 지금 안 고친 것)**

- 시야 bitmask(`writeVisibility`)를 매 스냅샷 tick마다 로스터 전원에 대해 `computeVisibility`를 새로 돌려서 만든다. 이미 연결된 뷰어의 시야는 `publish()` 쪽에서 한 번 더 계산되고 있어 중복이다(값은 같지만 계산은 두 번). 8인 기준으로는 무시할 만하다고 보고 넘겼지만, tick 예산이 빠듯해지면 여기부터 본다.
- `MemoryReplayRecorder`의 process-wide spool 상한(`processSpoolBytes`, 256MB)이 모듈 스코프 변수다. 여러 게임 프로세스가 아니라 "한 프로세스 안의 여러 방"을 막는 용도로는 맞지만, 정확한 상한값은 실측 없이 감으로 잡았다.
- `replays`/`replay_holds`/보존 정책/신고(`docs/REPLAY.md` 7~10절)는 손대지 않았다. `server-match`의 `replays` 테이블 insert(`result.service.ts`)는 이미 있어서 `replay` 필드가 채워지면 자동으로 DB에 남지만, 삭제·보존 주기는 아직 아무것도 안 돈다.

### R. 점검 라운드

실제로 한 판 돌아간 뒤. 아래 "나중에 볼 것" 목록을 훑는다. Opus인 이유는 여기서 찾을 것이
"스펙 위반"이 아니라 "그럴듯한데 틀린 것"이기 때문이다.

---

## codex가 할 것

0, A1, B1, D, E, A2 **전부 완료**. 커밋 73a8aca, 0ed27d7, 46804e0, b33c634, b5c0163, c03145c.

---

## 사용자가 할 것

- F 클라이언트 연결 — 방 API 연동, WebSocket 접속과 티켓 전송, 스냅샷을 엔진에 연결, 대기실 UI
- `config/gameplay.ts`의 밸런스 수치 전부. 지금 값은 구조를 보여주기 위한 임시값이다
- 시작 잠금 5초/10초가 실제로 답답한지, 예측 on/off 중 뭐가 나은지 같은 감각 판정

---

## 순서

```text
  [0 · A1 · B1 · D · E · A2]   전부 완료
  [S · C · 조립]               전부 완료
              │
              ▼
      [X 실제 경기 한 판] ──> [G 리플레이]   전부 완료
              │
              ▼
      [R 점검 라운드]                       다음 작업
```

---

## 나중에 볼 것 (R 라운드)

기능이 다 붙은 뒤 점검할 목록. 지금은 신경 쓰지 않는다.

- 티켓 검증의 원자적 소비와 실패 응답의 타이밍 차이
- Redis ACL 사용자 분리. 지금은 단일 비밀번호로 전부 접근 가능하다
- 세션 테이블 원본 IP의 보관 기간과 파기
- 위반 신호(`ViolationSignal`)의 실제 소비자 연결
- 결정론 테스트와 가짜 클라이언트 부하 테스트
- 8인 풀방 tick 측정 후 프로세스당 방 수 상한 확정
- `draining` 임계값과 연결 상한 확정
- outbox가 가득 찼을 때 신규 게임 시작 차단(`outbox.canStartNewGame`). 지금은 로그만 남기고 그 경기 전적이 유실된다
- `GameSession`이 방을 직접 참조한다. 지금은 메서드 6개만 쓰지만 늘어나면 경계가 새고 있다는 신호다

### X 진행 중 발견 (2026-08-24)

실제로 한 판 굴려보면서 나온 것들. 막는 버그는 바로 고쳤고(아래 "고침" 표시), 안 막는 건 여기 적어두고 넘어간다.

**고침**
- `server-match/src/rooms/rooms.module.ts`가 `SanctionModule`을 import하지 않아 `RoomsService` DI가 죽어 있었다. 서버가 아예 못 떴다.
- `server-game/src/main.ts`가 WS metadata와 heartbeat의 `protocolVersion`에 `bundle.schemaVersion`(맵 포맷 버전)을 넣고 있었다. `shared`의 `PROTOCOL_VERSION`(와이어 프로토콜 버전, 지금 2)과 다른 개념인데 섞여 있었다. 맵 버전은 1이라 매칭 서버의 `selectServer` 필터에 항상 걸려 `NO_GAME_SERVER`가 났다. `PROTOCOL_VERSION`을 쓰도록 고쳤다.
- `server-match`가 방 생성 시 `mapId` 미지정이면 리터럴 문자열 `'random'`을 그대로 인게임 서버에 보내는데, 인게임 서버는 `'random'`을 실제 맵 id로 풀어주지 않아 항상 `INVALID_MAP`이 났다. `CommandConsumer`에 `resolveMapId` 훅을 추가해 인게임 서버(맵 번들을 실제로 들고 있는 쪽)가 `'random'`을 로드된 맵 중 하나로 치환하게 했다.
- 3명으로 게임 시작하면 tick=1에 바로 끝났다. `game-lifecycle.ts`의 `#placePlayers`가 `start_pos`를 타일 인덱스로 착각해 `tileSize`를 또 곱해서 스폰 좌표가 맵 밖으로 수백 배 벗어났다(`tools/MapBuilder/builder.py`가 이미 픽셀 좌표를 내려줌). 재스케일을 빼고 좌표를 그대로 쓰게 고쳤다. 사용자 확인 후 진행(server-game 쪽 수정으로 확정).
- 위 스폰 좌표 수정 뒤 3명이서 실제로 경기를 시작하는 데까지는 됐는데, 게임 화면(`/game`)이 완전히 빈 화면이었다. `client/src/pages/GamePage.tsx`가 `engine.applySnapshot(frame)`만 호출하고 `engine.map.load(...)`를 어디서도 안 불러서 맵 타일이 로드된 적이 없었다(`MapController.load(view: MapView)`는 호출자가 명시적으로 넣어줘야 함 — `client/src/game/MapController.ts:13`). `client/src/pages/dev/EngineSandboxPage.tsx`가 쓰던 것과 같은 fixture(`dev/fixtures/serverMaps.ts` — `tools/MapBuilder`의 `server_maps.json`과 물리값이 완전히 동일한 걸 확인함, 타일셋 텍스처는 이제 안 씀)로 `engine.map.load()` 호출을 GamePage에 배선했다. 사용자 확인 후 client도 진행(원래는 사용자 소유라 안 건드리려 했다). 실제 게임 화면에서 맵 타일 렌더링 확인함, 콘솔 예외 없음, EngineSandboxPage에서 같은 렌더러로 플레이어 스프라이트도 정상 렌더링 확인함(라이브 화면에서 스프라이트까지 직접 스크린샷하려다 rate limit/latency로 막혀서 sandbox로 렌더러 자체를 교차 검증했다). **남은 진짜 문제**: `mapId`로 실제 서버 맵 번들을 받아오는 경로가 없다 — 지금은 클라이언트에 미리 박아둔 fixture 스냅샷을 그대로 쓴다. 맵이 바뀌면 fixture도 손으로 다시 내보내야 하고, 서버가 알지 못하는 mapId가 오면 조용히 실패한다(`console.error`만 찍고 빈 화면). 장기적으로는 `mapBundleHash`로 실제 번들을 fetch하는 경로가 필요하다.

- 경기 결과가 DB에 한 건도 안 남고 있었다(사용자가 직접 확인 요청해서 발견). 원인이 네 개나 겹쳐 있었다 — 하나씩 고칠 때마다 다음 게 드러났다:
  1. `server-match`가 방 생성 시 `matches.map_id`에 미해결 `'random'`을 그대로 저장하는데, 실제 경기 결과의 `mapId`는 인게임 서버가 해석한 진짜 맵 이름이라 `record()`의 일관성 체크(`match.mapId !== result.mapId`)에서 항상 `invalid`로 걸렸다. `CreateRoomResult`(shared)에 `mapId` 필드를 추가하고, 인게임 서버가 해석된 맵을 응답에 실어 보내고, `ResultService.confirmRoom(matchId, roomId, mapId)`이 방 생성 확정 시점에 `matches.map_id`를 진짜 값으로 덮어쓰게 했다.
  2. `server-match/src/results/result.codec.ts`의 `isMatchResult`가 `winnerPlayerIds[0] === winnerPlayerIds[1]`이면 무조건 `malformed`로 버렸다. 그런데 `server-game/src/game/game-session.ts`의 `#finish()`는 생존자가 1명만 남으면 의도적으로 같은 id를 두 번 채운다(주석: "동시 탈락으로 더 적게 남을 수 있다. 자리를 억지로 채우지 않고 남은 만큼만 승자로 본다"). 검증 쪽이 인게임 서버의 의도된 동작을 몰랐던 것 — 중복 거부 조건을 뺐다.
  3. 위 둘을 고치고도 여전히 `malformed`였다. `isMatchResult`가 `survivedMs > durationMs`(각 플레이어의 생존 시간이 경기 전체 길이를 넘으면 조작으로 간주)를 체크하는데, `survivedMs`는 시뮬레이션 tick 시계로, `durationMs`(`endedAt - startedAt`)는 벽시계로 잰다. 100초 넘는 실제 경기에서 스케줄러 catch-up 때문에 두 시계가 20ms 남짓 어긋났고, 그 사소한 오차로 정상 결과가 매번 걸렸다. 2초 tolerance를 넣었다(`SURVIVED_MS_CLOCK_SKEW_TOLERANCE_MS`).
  4. (참고) 위 세 개를 고치기 전, tick=1에 끝난 옛날 경기들도 같은 이유들로 `malformed`/`invalid`로 버려졌던 걸 로그에서 확인함 — 그 경기들은 스폰 버그 자체가 원인이라 다시 안 만듦.
  네 개 다 고친 뒤 실제 3인 경기(6196틱, ~103초) 결과가 `matches`(map_id="BattleField", duration_ticks=6196, started_at/ended_at/result_recorded_at 전부 채워짐)와 `match_participants`(3행, is_winner/tag_count/tagged_count/survived_ms 전부 정상)에 제대로 저장되는 것까지 직접 쿼리로 확인함.

**안 막지만 남겨둠 (R 라운드나 여유될 때)**
- `RoomListPage`가 마운트되자마자 방 목록을 요청하는데, `useAuthStore.bootstrap()`의 refresh-cookie 복구보다 먼저 나가서 새로고침 직후엔 401이 한 번 뜬다. 그 다음 재시도(수동 새로고침 버튼)에서는 정상 동작. `client/src/pages/rooms/RoomListPage.tsx`
- 방 생성 흐름: `registry.start()`가 heartbeat를 올려 매칭 서버에 "이 서버 씀직함"으로 보이자마자, `consumer.start()`(명령 소비자)는 아직 안 붙어 있는 startup 윈도우가 있다(`server-game/src/main.ts`의 `connectRedis()`가 registry→consumer 순서로 순차 실행). 이 사이에 들어온 `CREATE_ROOM`은 아무도 안 읽어서 `COMMAND_TIMEOUT`으로 죽는다. 로컬 재현: 서버 기동 직후 30초 안에 방 만들기 시도.
- `COMMAND_TIMEOUT_MS = 2000`(`server-match/src/rooms/rooms.service.ts`)이 로컬 개발 환경에서도 여유가 별로 없다. 정상 처리되는 요청도 왕복이 1~2초 걸리는 걸 몇 번 관찰했다(원인 미확인 — Redis stream round trip 자체가 이렇게 느릴 이유가 없어 보임). 타이트한 타임아웃 하나가 간헐적 `EXPIRED`를 만든다. **부작용 확인**: 이 상태에서 quick-join이 timeout 나면 `user:{userId}:active-room` claim이 `'reservation'` 상태로 박힌 채 남고, 그 다음 재시도는 `existingRoomResponse`가 `{alreadyAssigned:true}`(roomId 없이)를 돌려줘서 클라이언트가 아무 데도 못 간다. `ACTIVE_ROOM_RESERVATION_TTL_SECONDS = 30`초 지나야 풀린다 — 그동안 그 계정은 방을 못 만들고도 못 들어간다.
- 방 코드 계약이 어긋나 있다: 인게임 서버가 `roomId`를 `randomUUID()`(36자)로 만드는데(`server-game/src/redis/command-consumer.ts`의 `roomIdFactory` 기본값), 클라이언트의 코드-참가 입력창은 `maxLength={6}`이고 `isRoomId`가 `/^[A-Za-z0-9]{6}$/`만 통과시킨다(`client/src/pages/rooms/JoinRoomPage.tsx`, `client/src/utils/validation.ts`). 방금 만든 방을 코드로 못 들어간다 — 지금은 "빠른 참가"로 우회해서 테스트했다. 둘 중 하나가 실제 계약에 맞춰야 한다: 인게임 서버가 짧은 코드를 만들거나, 클라이언트가 UUID를 받게 하거나.
- `npm test`(server-game)의 `node --test "dist-test/**/*.test.js"` glob이 안정적이지 않다. 같은 명령을 반복 실행해도 매번 다른 개수(96 / 99 / 89 등)가 잡히고, 어떤 실행에서는 `dist-test/game/*.test.js`가 통째로 빠진다. 파일은 항상 존재하고 개별 실행하면 통과한다 — node 자체의 재귀 glob discovery 문제로 보인다. CI에서 조용히 테스트가 덜 도는 상태일 수 있어 R 라운드에서 확인 필요.
- `client/vite.config.ts`의 프록시 규칙이 `/game` 경로 접두어로 WS 요청(`ws://localhost:4000`)을 잡는데, 클라이언트 라우터의 실제 페이지 경로도 `/game`이다(`GamePage`). SPA 내부 네비게이션(`navigate('/game?...')`)은 새 HTTP 요청을 안 만들어서 문제가 없지만, `/game?room_id=...`에서 브라우저 새로고침(F5)이나 직접 URL 접속을 하면 vite dev 서버가 이 요청을 WS 프록시로 보내버려서 404가 난다. 실사용자가 게임 중 새로고침하면 그대로 재현될 것.
- COMMAND_TIMEOUT/latency 이슈가 세션이 길어질수록(오래 켜둔 `nest --watch` 프로세스, 반복된 join/leave) 더 자주 재현됐다 — 짧은 시간에 quick-join을 여러 번 재시도하면 `참가 빈도 제한(분당 6회)`에도 금방 걸린다. 둘이 겹치면(타임아웃 → 재시도 → rate limit) 사용자 입장에서는 그냥 방에 못 들어가는 것처럼 보인다.

### 테스트 계정 (2026-08-24)

X 진행하면서 만든 로컬 계정. SMTP가 실제 Gmail로 뚫려 있어서 새 계정을 계속 만들면 존재하지 않는 도메인(example.com)으로 보낸 메일이 사용자에게 반송 에러로 온다 — **새로 만들지 말고 아래 계정을 재사용한다.**

| 이메일 | 비밀번호 | 닉네임 |
| --- | --- | --- |
| switch.tester1@example.com | TestPass123! | Player1 |
| switch.tester2@example.com | TestPass123! | Player2 |
| switch.tester3@example.com | TestPass123! | Player3 |

인증 코드가 필요하면(비번 재설정 등) 이메일로 안 오니 Redis에서 바로 읽는다: `auth:code:{vtype}:{email}` 키(`vtype`은 `signup`/`reset-password`/`delete`).

---

## 게스트 기본 신분과 후속 버그 (2026-08-24, 구현·자동 검증 완료)

> 아래 항목은 2026-08-24 구현 후 shared 34개, server-game 97개, server-match 25개(통합 1개는 DB opt-in이라 제외) 테스트와 client production build로 검증했다. 실제 다중 브라우저 한 판 E2E는 별도 실행이 필요하다.

### 결정된 제품 정책

- **계정 로그인은 방 목록·방 생성·방 참가의 자격 조건이 아니다.** 비로그인 사용자도 모두 사용한다.
- 클라이언트는 첫 진입 시 임시 guest session을 자동으로 받고, 방 API/WS에서 이 access JWT를 account access JWT와 같은 Bearer token처럼 처리한다.
- 같은 탭에서는 F5 후에도 같은 guest ID/닉네임을 유지한다. 탭을 닫으면 소유권은 사라지고 서버의 임시 세션도 짧은 TTL 후 자동 삭제된다.
- account의 추가 효과는 **영구 통계/전적, 계정 관리, guest보다 높은 rate limit**이다.
- guest도 경기 결과의 무결성을 위해 `match_participants` 로우로는 남기되, `user_id = null`, `is_guest = true`로 계정 통계에 합산하지 않는 현재 규칙을 유지한다.
- 신분은 `anonymous(no token)`, `guest`, `account`를 명확히 구분한다. anonymous는 guest 발급·로그인·회원가입 같은 인증 경계에만 짧게 존재하고, 방 UI를 보이기 전에 guest/account 중 하나로 bootstrap이 끝나야 한다.

### P0. 첫 화면부터 탭 고정 guest JWT session

#### 현재 코드에서 확인한 원인/추가 버그

1. `POST /auth/guest`는 이미 `g:{uuid}` ID와 guest access JWT를 발급하지만(`server-match/src/auth/auth.service.ts`, `auth.controller.ts`), 클라이언트가 첫 진입 시 이를 받거나 갱신/복구하는 흐름이 없다. `useAuthStore.bootstrap()`은 account refresh cookie만 복구한다.
2. `RoomListPage`가 auth bootstrap보다 먼저 방 목록을 요청해 첫 401이 난다. `apiRequest()`도 access token이 이미 있어야만 401 refresh를 시도한다.
3. `@NeedLogin()`의 `LoggedInGuard`는 `request.user`만 있으면 통과시킨다. 방 API에서 guest가 통과하는 것은 원하는 동작이지만, 같은 guard를 쓰는 `SessionController`/`UserController`의 **account-only API까지 guest가 통과**한다. `sessionId` 없는 문자열 guest ID를 정수 account ID로 가정하는 보안/안정성 버그다.
4. 전역 `RateLimiterGuard`는 `req.user` 유무로 `anon`/`user` 두 등급만 고르므로 guest JWT도 account와 같은 상한을 받는다.
5. 현재 로그아웃은 세션 목록에서 current session을 찾았을 때만 서버 revoke/쿠키 제거를 한다. 목록 로드가 실패하면 로컬 token만 지워 refresh cookie로 새로고침 후 다시 로그인된다(`ProfilePage.tsx`).
6. 회원가입 성공 후 account token 없이 닉네임만 auth store에 넣는 흐름은 guest JWT의 닉네임과 UI를 불일치시킨다. 가입 성공은 guest 신분을 변경하지 말고 실제 login 성공 시에만 account로 바꿔야 한다.

#### 채택할 토큰/세션 구조

- **guest access JWT**: API/WS Bearer 용도. 현재 수명 15분(`JWT_GUEST_EXPIRATION=900`) 정도를 유지하고 `type: 'guest-access'`, `sub`, `nickname`, `guest: true`, `sid`, `iat`, `exp`를 담는다.
- **guest refresh JWT**: 1시간 idle TTL. `type: 'guest-refresh'`, `sub`, `sid`, `jti`, `iat`, `exp`를 담고 access JWT와 용도를 엄격히 구분한다. `JWT_GUEST_REFRESH_SECRET`, `JWT_GUEST_REFRESH_EXPIRATION=3600`을 별도 설정해 account refresh와 오인식하지 않게 한다.
- **Redis 임시 session**: DB `sessions`는 쓰지 않고 `guest-session:{sid}`에 guest ID/닉네임/현재 refresh `jti` 또는 token hash만 1시간 TTL로 저장한다. refresh할 때 compare-and-set/Lua로 일회용 회전하고 TTL을 1시간 연장한다. 탭이 살아 있는 동안은 같은 guest를 계속 쓰고, 탭을 닫은 뒤 최대 1시간 후 자동 제거된다.
- **클라이언트 저장**: guest refresh JWT만 `sessionStorage`에 넣고 access JWT는 현재처럼 메모리에 둔다. `localStorage`는 탭을 닫아도 남고, cookie는 모든 탭이 공유하므로 “탭 고정 guest” 요구와 맞지 않다.
- 이는 무상태 refresh JWT보다는 조금 복잡하지만, account DB session에 의존하지 않고 1시간 sliding session과 refresh replay 차단을 모두 얻는 구조다.

#### server/auth 수정 계획

1. `POST /auth/guest`가 access token, guest refresh token, guest 표시 정보, 두 만료 시간을 반환하게 한다. 발급은 IP로 엄격히 제한한다.
2. `POST /auth/guest/refresh`를 추가해 JWT와 Redis의 현재 jti/hash를 모두 검증하고, 성공 시 같은 guest의 access+refresh 페어를 회전한다. replay/만료/세션 소실은 401로 끝낸다.
3. `NeedLogin` 의미를 폐기하고 `NeedActor`(guest/account, RoomsController/WS) 및 `NeedAccount`(`guest === false`, 정수 user ID, 유효한 sessionId; SessionController/UserController/통계)로 분리한다. guest의 account API 호출은 DB 오류가 아닌 403(팀 정책이 401이면 401)로 끝낸다.
4. `RateLimitOptions`를 `anon`/`guest`/`account` 3등급으로 바꾸고 tracker도 `ip:`, `guest:`, `account:`로 분리한다. 방 생성/참가는 account보다 guest 상한을 낮게 잡고, guest는 기존 `RoomsService.assertGuestJoinRate()`의 actor ID + IP 이중 제한을 유지한다. 같은 요청을 의도치 않게 두 번 카운트하지 않도록 레이어별 차감 책임을 명세한다.
5. `POST /auth/logout`을 추가해 session 목록 조회 성공 여부와 무관하게 현재 account session revoke + refresh cookie 제거를 수행한다. 성공 후 client는 즉시 새 guest를 발급한다.
6. Redis key는 `shared` `makeKeys()`에 `guestSession(sid)`를 추가해 사용한다. **shared 계약 변경이므로 현 소유자/동시 수정 여부를 확인한 뒤 적용**하고 key prefix 충돌 테스트를 추가한다.

#### client bootstrap/UI 수정 계획

1. auth state를 `booting | guest | account | error`로 명확히 나누고 access token 유무만으로 account를 판단하지 않는다.
2. 앱 시작 순서는 (a) sessionStorage guest refresh가 있으면 guest refresh, (b) 없으면 account refresh cookie 복구, (c) 둘 다 실패/부재면 새 guest 발급이다. 성공 전에는 방 화면을 마운트하지 않아 첫 방 목록 401을 없앤다.
3. login 성공 시에만 guest refresh를 지우고 account로 교체한다. login 실패/회원가입 성공은 현재 guest 신분을 변경하지 않는다.
4. 401 회복은 신분별 single-flight로 account는 `/auth/refresh`, guest는 `/auth/guest/refresh`를 한 번만 호출하고 원요청을 1회만 retry한다. 동시 401이 refresh 회전을 충돌시키지 않도록 Promise를 공유한다.
5. guest refresh 만료 시 활성 방/경기가 없으면 새 guest를 발급한다. 활성 방/경기 중이면 새 ID로 조용히 바꾸지 말고 세션 만료를 안내한 뒤 방 목록으로 복귀한다.
6. Profile은 guest 닉네임을 보여 줄 수 있지만 session 목록/비번 변경/계정 삭제/영구 통계는 account에서만 노출한다. guest를 기존 `authenticated` 불리언과 동치시켜 `getLoginSessions()`를 호출하지 말 것.
7. 방/경기 중 login/logout은 active-room claim이 guest/account 두 신분으로 갈라지므로 1차 구현에서 UI와 가능한 server 경계 모두에서 막고 이유를 안내한다. guest→account 방 소유권 이전은 별도 원자적 프로토콜 없이 암묵적으로 하지 않는다.

#### guest 완료 조건

- 처음 방문한 브라우저에서 login 없이 방 목록·생성·코드 참가·빠른 참가가 된다.
- 같은 탭 F5에서 guest ID/닉네임이 유지되고, 15분 이상 열어 둔 탭에서도 401 노출 없이 회전된다.
- 탭을 닫은 뒤 1시간 이상 refresh가 없으면 Redis guest session이 사라지고, 회전 전 refresh token replay는 거부된다.
- guest는 room API에 접근하지만 account session/계정 API에는 접근하지 못하고 account와 다른 rate limit을 적용받는다.
- logout 직후 guest로 자동 전환되고, F5 후 폐기한 account cookie로 다시 login되지 않는다.
- guest 경기는 participant row를 남기되 account stats에 합산되지 않는 기존 integration test를 통과한다.

### P0. 인게임은 실행되지만 자기 플레이어가 안 보임

**정적 분석으로 확인한 원인**: GamePage snapshot은 `Engine.applySnapshot()`으로 들어가고 플레이어 스프라이트 렌더러도 sandbox에서 정상이다. 그러나 카메라는 `freeCamera = true`, `(x, y) = (0, 0)`에서 시작하고, `WorldScene.setSelf()`는 self ID만 설정할 뿐 `camera.follow(selfId)`를 호출하지 않는다. `EngineMode`(`play`/`spectate`)도 실질적으로 사용되지 않아, 스폰이 월드 원점에서 멀면 화면에 아무도 없는 것처럼 보인다. 앞서 고친 “GamePage가 맵을 load하지 않음”과는 별개의 남은 문제다.

**수정 계획**:

1. `Engine` mode를 `WorldScene`/카메라 초기화 정책까지 전달한다.
2. play mode에서 첫 snapshot이 self player를 실제 생성한 직후 **한 번만** `camera.follow(selfId)`한다. `setSelf()` 시점에 sprite가 아직 없을 수 있으므로 pending self ID를 두고 snapshot materialization 후 처리한다.
3. 매 snapshot마다 follow를 강제하지 말고 `cameraInitialized`/명시적 사용자 선택을 두어 최초 1회만 자동 follow한다. spectate mode는 임의 player를 자동 follow하지 않는다.
4. snapshot 적용 예외를 완전히 숨기지 말고 room/tick/selfId 정도를 남긴 제한된 진단 로그를 남긴다.

**검증**: 맵 원점에서 멀리 스폰하는 fixture, self가 두 번째 snapshot에 등장하는 fixture, spectate mode, free camera 전환 후 후속 snapshot을 테스트한다. 실제 3인 경기에서 self/상대 sprite와 카메라 추적을 눈으로 확인한다.

### P0. room create/quick-join `COMMAND_TIMEOUT`, 준비 전 노출, 유령 reservation

#### 서로 다른 두 문제로 분리

- **기동 직후의 확정된 준비 순서 버그**: `server-game/src/main.ts`/Redis 기동에서 registry heartbeat가 먼저 서버를 healthy로 노출하고 command consumer가 나중에 붙는 창이 있다. 이 때 `CREATE_ROOM`은 소비자가 없어 timeout난다.
- **정상 운영 중의 1~2초 지연은 원인 미확정**: `COMMAND_TIMEOUT_MS=2000`에 가까운 지연이 오래 켜 둔 watch process에서 자주 보였지만 Redis round trip, consumer lag, event-loop stall, reply polling, DB/lock 중 어디가 원인인지는 측정 전에 단정하지 말 것.

#### 수정 순서

1. request ID로 `match enqueue -> game consume -> room create/join -> reply publish -> match receive`의 monotonic timestamp과 stream/consumer lag를 기록해 병목을 먼저 확정한다. 로그에 `requestId`, `serverId`, `roomId`, stage elapsed를 남긴다.
2. game server는 command consumer가 구독 준비를 끝낸 후에만 registry ready/heartbeat를 노출한다. 종료는 반대 순서로 한다. 준비 전 server를 `RoomsService` 선택 후보에 넣지 않는 테스트를 추가한다.
3. timeout 숫자만 키우지 말고 계측 결과로 정상 상한을 재설정한다. network timeout과 operation 실패를 구분해 “결과 미확정” 상태를 따로 둔다.
4. `CREATE_ROOM`/`JOIN_ROOM`은 같은 request ID 재전송이 같은 결과를 돌려주는 idempotency를 보장한다. timeout 후 원 request ID로 재확인/재전송하고, 늦게 온 reply는 operation cache와 대조해 회수한다.
5. quick-join 후보별 시도와 최상위 user operation을 구분하고, 모든 경로에서 `user:{actorId}:active-room='reservation'`을 commit(room ID)/rollback 중 하나로 종료하는 `finally`/원자적 Lua를 둔다. `{alreadyAssigned:true, roomId 없음}`을 정상 응답으로 반환하지 말 것.
6. timeout된 create가 game server에서 늦게 성공한 경우 match DB/active-room/directory가 모두 그 방을 인지하거나 모두 보상 삭제하도록 상태 전이를 정의한다.

**검증**: consumer 준비 전 명령, late reply, 같은 request ID 중복, quick-join 첫 후보 timeout/두 번째 성공, process restart를 가상 시계로 테스트한다. 한 번의 UI 행동이 retry 때문에 rate limit에 여러 번 차감되지 않아야 한다.

### P1. 방 코드 6자리와 내부 `roomId` UUID 계약 분리

**원인**: game server는 UUID `roomId`를 만들지만 client code-join은 6자 영숫자만 받는다. UI만 UUID를 받게 늘리지 말고 다음 계약으로 고정한다.

- `roomId`: 서버·Redis·WS·URL이 쓰는 내부 UUID, 불변.
- `roomCode`: 사용자가 보고 입력하는 6자 대문자+숫자. 혼동 문자를 빼고 server에서 생성한다.
- room directory에 code→roomId 역인덱스를 room TTL과 함께 두고, 충돌 시 유한 횟수 재생성한다. room 삭제 시 역인덱스도 지운다.
- shared `CreateRoomResult`, room list/detail DTO, join command에 `roomCode`를 추가한다. code join은 code를 roomId로 resolve한 뒤 기존 join command를 쓴다.
- client Lobby/초대 UI는 code를 보이고 URL/WS는 roomId를 유지한다. `matches.room_id`와 result idempotency도 계속 UUID를 써야 한다.
- `shared`, game command consumer/directory, match `RoomsService`, client API/validation/LobbyPage를 함께 검색해 타입 계약을 한 번에 전환한다.

### P1. `/game` F5/직접 URL 404와 실제 경기 복구 부재

1. `client/vite.config.ts`의 WS proxy를 SPA route `/game`과 겹치지 않는 전용 접두어(예: `/game-ws`)로 바꾸거나 WS upgrade/하위 경로만 proxy하게 한다. `GET /game?room_id=...`는 Vite SPA fallback으로 가야 한다.
2. proxy만 고쳐도 `GamePage` 마운트 시 active room 복구가 없으므로 불충분하다. guest/account bootstrap 완료 → URL `room_id` 검증 → active-room 조회/복구 → 새 WS ticket → connect → snapshot 적용 순서를 구현한다.
3. disconnect grace 10초 안에 일반 F5 복구가 들어오는지 측정하고, 시간을 늘리기 전 client bootstrap/WS 병목을 먼저 제거한다.
4. lobby/game/end 상태와 만료 guest refresh 각각의 F5 결과를 정의해 테스트한다.

### P1. runtime map bundle 경로 부재

현재 GamePage는 `dev/fixtures/serverMaps.ts`를 로드해 빈 화면은 해결했지만 server가 선택한 `mapBundleHash`를 받는 경로가 없다.

- bootstrap의 `mapId`+`mapBundleHash`로 immutable bundle을 fetch하고 hash를 검증한 후 `engine.map.load()`한다.
- loading 중 snapshot은 유한 크기로 버퍼링하거나 최신 full snapshot 하나만 잡고, 실패 시 retry/나가기가 있는 명시적 UI를 보인다.
- fixture는 sandbox/오프라인 test로만 남기고 production GamePage fallback으로 쓰지 않는다.
- bundle serving 소유권, cache header, hash 알고리즘은 shared/server-game/client 계약을 먼저 고정한 뒤 구현한다.

### P1. `server-game` test discovery 비결정성

`node --test "dist-test/**/*.test.js"`가 반복 실행에서 다른 테스트 수를 실행한 것은 확인했지만 “Node 자체 glob bug”로는 아직 확정하지 말 것. compile 후 `dist-test` 목록, reporter 시작 목록, shell/Node 버전별 glob 확장을 비교한다. 해결은 OS/shell glob에 의존하지 않는 Node launcher가 `*.test.js`를 재귀적으로 정렬·나열해 runner에 명시적으로 넘기는 방식으로 한다. 발견 0개는 실패시키고 CI log에 발견/실행 파일 수를 남긴다.

### 구현 순서와 충돌/회귀 체크리스트

1. **선행 상태 확인**: worktree 차이, 다른 세션의 test 결과/수정, `docs/TASKS.md`의 새 내용을 먼저 재확인한다. 이미 고쳐진 항목은 재구현하지 않는다.
2. **auth boundary first**: `NeedActor`/`NeedAccount` 분리와 guest의 account API 차단을 먼저 테스트한다. guest-first UI를 켜기 전에 막아야 할 기존 보안 버그다.
3. **guest server lifecycle**: Redis session, issue/refresh rotation/logout, 3-tier rate limit을 test와 함께 구현한다. Redis 장애/재시작 시 새 guest로 안전하게 fallback하되 active game 중 신분을 조용히 바꾸지 않는다.
4. **client bootstrap**: auth state 분리, sessionStorage refresh, single-flight 401, Profile/login/signup/logout을 구현한 뒤 첫 요청 401과 account cookie 복구를 확인한다.
5. **camera auto-follow**를 작은 독립 변경으로 처리하고 실제 경기로 검증한다. map bundle 작업과 묶어 원인을 혼합하지 말 것.
6. **control-plane readiness -> measurement -> timeout/idempotency/reservation** 순서로 진행한다. 현재 결과 저장에서 쓰는 `requestId`, `matchId`, `roomId`, `mapId` idempotency를 깨지 않는지 확인한다.
7. **roomCode shared contract**은 관련 server/client를 한 번에 전환한다. 구버전 producer/consumer 호환 창이 필요하면 optional field -> 전체 배포 -> required field 순서로 옮긴다.
8. **F5 recovery/map bundle**은 guest identity 복구와 roomCode/roomId 분리가 안정된 뒤 연결한다.
9. **full regression**: server-match unit/integration, server-game의 명시적 전체 test 명단, client typecheck/build/test를 돌린다. 그 뒤 guest 3 tabs + account 1 tab으로 create -> code join -> ready -> game -> F5 recovery -> result DB save를 통과한다. guest stats 제외, account stats 합산, active-room 잔존 key 0, 닫힌 room의 directory/code reverse index 잔존 0을 직접 확인한다.

#### 파일/계약 영향 검색 범위

- `server-match`: `src/auth/**`, `src/session/**`, `src/user/**`, `src/rooms/**`, `src/results/**`, `src/ratelimiter.*`, config/env validation, app module/global guard order.
- `server-game`: Redis registry/consumer/reply, room directory/lifecycle, WS handshake/ticket/active-room, result payload, startup/shutdown order.
- `client`: `src/api/http.ts`, auth/rooms/matches/sessions API, `useAuthStore`, Router/root bootstrap, login/signup/profile, RoomList/Create/Join/Lobby/GamePage, game `Engine`/`WorldScene`/`CameraController`, `vite.config.ts`, i18n.
- `shared`: JWT actor/request type, room `roomId`/`roomCode`, create/join/result protocol, Redis `makeKeys`, map bundle identity. **shared를 바꾸면 `server-match`, `server-game`, `client`의 typecheck를 같은 작업 단위에서 확인**한다.
- docs/infra: `.env.example` 및 deployment secret, Redis TTL/key 명세, API schema, client dev proxy. 실제 secret이나 발급 token은 문서/log에 남기지 않는다.
