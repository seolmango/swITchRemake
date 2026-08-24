# swITch 작업 큐

Claude와 codex가 같은 워킹 트리에서 작업한다. **codex가 구현하고, Claude가 계약·설계·점검을 맡는다.**
이 문서가 유일한 작업 큐다. 계약을 바꾸는 작업은 문서를 먼저 고친 뒤 코드를 고친다.

## 개발 방식

기능 구현을 먼저 하고, 취약점과 오류 점검은 마지막에 한 번에 돈다(R). 공개 서비스가 아니라 가능한 방식이다.
되돌리기 비싼 것 — 와이어 계약, 저장 형식, 결과의 버전 스탬프 — 은 처음부터 문서대로 넣는다.

## 파일 소유

| 경로 | 소유 |
| --- | --- |
| `shared/` | Claude. 다른 세션은 **읽기만**. 계약 변경은 Claude가 먼저 하고 알린다 |
| `server-game/src/simulation/` | Claude |
| `server-game/src/config/`, `client/src/game/constants.ts` | 공유. **값을 추가해야 하면 먼저 알린다** |
| `server-game/` 나머지, `server-match/`, `client/`, `e2e/` | codex |
| `tools/` | codex. 맵 포맷을 바꾸면 Claude에게 알린다 |
| `docs/` | 누구든. 계약을 바꿀 때는 문서를 먼저 고친다 |

> 이전 큐에서 `client/`는 사용자 소유였다. 지금은 codex가 구현하고 사용자는 밸런스(`config/gameplay.ts`)와
> 감각 판정(시작 잠금 길이, 예측 on/off, 스킬 체감)만 맡는다. 다르게 하고 싶으면 이 줄을 고친다.

## 문서 지도

| 문서 | 무엇 | 언제 읽나 |
| --- | --- | --- |
| `SERVER_ARCHITECTURE.md` | 두 서버의 책임, 신뢰 경계, Redis/WS 계약, 방 상태 머신 | 서버 작업 전부 |
| `ENGINE.md` | 클라이언트 엔진의 공개 API, React↔Phaser 경계, 표시 옵션 | 클라이언트 인게임 작업 |
| `REPLAY.md` | 리플레이 프레임·파일 형식·저장소·재생 | T4, T7 |
| `FUTURE.md` | 아직 안 만든 것 — 운영자 페이지, 신고, 안티치트 | 지금은 참고만 |
| `TASKS.md` | 이 문서. 작업 큐 | 항상 |

---

## 지금 상태 (2026-08-24)

경기가 끝까지 굴러가고 결과가 DB에 남는 것까지 확인했다. 게스트 신분, 방 코드/roomId 분리, 런타임 맵 번들
fetch, `/game` F5 복구, 카메라 자동 추적, 리플레이 기록·CLI까지 붙었다.

**완료 기록** (상세는 git log)

| 묶음 | 내용 | 커밋 |
| --- | --- | --- |
| S·C·조립 | shared 계약, 시뮬레이션·시야·스킬, `game/` 계층과 `main.ts` | b6dec64, 3c86ea4, 96c3646 |
| 0·A·B·D·E | 매칭 서버, 게이트웨이, Redis 컨트롤 플레인, 방, 결과 저장 | 73a8aca, 0ed27d7, 46804e0, b33c634, b5c0163, c03145c |
| X | 실제 경기 한 판. 스폰 좌표·`protocolVersion`·`'random'` 맵·결과 저장 4중 버그 수정 | de2dea6 이전 |
| 게스트/복구 | 게스트 JWT 세션, `NeedActor`/`NeedAccount` 분리, 3등급 rate limit, roomCode, 맵 번들 fetch, F5 복구, 카메라 follow | de2dea6 |
| G | 리플레이 recorder·컨테이너 형식·local store·CLI | f20f354 |

**남은 것**: 아래 T0~T11과 마지막 R. T1(a870c1f)·T2(3cda80d) 완료.

---

## 작업 순서

```text
  T0 스킬 입력 배선 ────┬─> T5 도움말 리뉴얼 ──> T6 훈련장
   (게임이 성립하는 조건) │
                        │
  T1 테스트 러너 [완료] ─┼─> T2 이메일 모드 [완료] ─┬─> T8 E2E 자동화 ──> T10 테스트 정리
                        │                          │
                        │                          └─> T3 통계 연결
                        │
                        ├─> T4 리플레이 코덱 shared 이관 ──> T7 로컬 재생기
                        │
                        └─> T9 클라이언트 점검

                              T11 문서 정리 ──> R 점검 라운드
```

지켜야 하는 것은 네 개뿐이다.

1. **T0이 제일 먼저.** 지금 스킬을 쓸 수 없어서 게임이 성립하지 않는다. T5도 T6도 이 위에 얹힌다.
2. **T10(테스트 정리)은 T8(E2E) 뒤에.** 그물을 새로 치기 전에 옛 그물을 걷으면 그동안 아무것도 안 잡힌다.
3. **T7(웹 재생)은 T4(코덱 이관) 뒤에.** 지금 코덱은 `node:zlib`/`node:crypto`에 묶여 브라우저에서 안 돈다.
4. **R은 항상 마지막.** 코드가 더 안 움직일 때 도는 라운드다.

나머지는 병렬로 해도 된다.

---

## T0. 스킬 입력 배선 — 지금 게임이 성립하지 않는다

**왜**: 2026-08-24 점검에서 확인했다. **스위치를 쓸 방법이 저장소 어디에도 없다.** 게임 이름이 swITch인데
핵심 메커니즘이 클라이언트에서 끊겨 있다. 경로를 끝까지 따라간 결과다.

- 서버는 `game.useSkill { slot, targetPlayerId? }`를 정상적으로 받는다. `slot 1`이 스위치, `slot 2`가 이동
  스킬이다(`simulation/skills.ts:229`). 쿨타임·사거리 판정도 tick 경계에서 제대로 돈다.
- 클라이언트는 **`slot 2`만 보낸다**(`GamePage.tsx:202`). `slot 1`을 보내는 코드가 저장소 전체에 없다.
- **조준 UI가 죽어 있다.** 스위치는 설계상 `SkillBar`의 버튼이 아니라 `PlayerList`의 번호 칩을 눌러 대상을
  지목하는 방식이다(`hud/PlayerList.tsx:33`의 주석, 레거시 `main.js:283-292`). 그래서 `SkillBar`의 스위치
  슬롯이 `passive`인 것은 **정상이다.** 문제는 `GamePage`가 `hud.switchTargets`를 **빈 배열로 하드코딩**하고
  (`GamePage.tsx:186`) `onSwitchTarget`을 아예 넘기지 않는 것이다. 지목 가능한 사람이 늘 0명이라 칩을 눌러도
  아무 일도 안 난다.
- 이동 스킬조차 **HUD 클릭으로만** 된다. 키보드 입력은 이동 4방향만 보내고 `heldActions`를 **0으로
  하드코딩**한다(`GamePage.tsx:160`). 와이어 프로토콜과 시뮬레이션은 `heldActions`를 제대로 나르는데
  클라이언트가 채우지 않는다. 결과적으로 설정의 `movementSkill`·`switch1~8`·`emoji1~8` **바인딩 18개가 죽은 키다.**
- **스냅샷에 쿨타임이 없다.** `SnapshotPlayer`에 `effects`는 있는데 `cooldowns`가 없다
  (`shared/src/protocol/snapshot.ts:23`). 그래서 HUD의 `cooldown: 0`도 하드코딩이고, 쿨타임 표시가 원리적으로
  불가능하다. **클라이언트가 추측하면 안 된다** — 거절된 스킬 요청까지 쿨타임을 소모하므로(`skills.ts:204`)
  추측한 타이머는 서버와 어긋난다.
- **실패 피드백이 없다.** `useSwitch`는 `OUT_OF_RANGE`/`NO_TARGET`/`ROLE`을 구분해 반환하는데 실패 시
  `events`에 아무것도 넣지 않는다. 플레이어는 쿨타임만 날리고 왜 안 됐는지 모른다.
- `lobby.setLoadout`은 서버가 **무조건 `InvalidPayload`로 거절**한다(`rooms/room-manager.ts:251`,
  주석: "shared에 허용 skill 집합과 lobby.state의 skills/control 필드가 아직 없다"). **스킬 선택이 저장되지 않는다.**
  게다가 클라는 `{skills, control}`을 보내는데 서버 검증은 `exactKeys(payload, ['skills'])`라 형태도 어긋나 있다.
- `game.emoji`는 서버가 받고 아무것도 하지 않는다. 브로드캐스트 이벤트가 shared 카탈로그에 없다.

X 라운드에서 "3인 경기가 끝까지 돌았다"고 확인한 것은 **아무도 스킬을 쓰지 않은 경기**였다.

**대상 선택 방식은 이미 정해져 있다.** 새로 결정할 것이 아니다 — `switch1~8` 키 바인딩, `showPlayerNumber`
설정, `PlayerList`의 번호 칩, 서버 `useSwitch`의 필수 `targetPlayerId`가 전부 같은 설계를 가리킨다.
**술래 사거리 안에서 다른 사람의 번호를 눌러 그 사람에게 술래를 넘긴다.**

**할 것**

1. **shared 계약(Claude 선행)** — 이게 없어서 서버가 거절하고 있다.
   - 허용 skill 집합(`SkillId`와 로드아웃 가능 목록), `lobby.state`의 `skills`/`control` 필드.
   - **스냅샷에 self 전용 쿨타임 섹션을 추가한다.** 슬롯 2개의 남은 tick만 보내면 된다(뷰어 본인 것만).
     남에게 보낼 필요가 없으므로 대역폭 영향은 무시할 수준이다.
   - 스킬 실패 사유 이벤트(`OUT_OF_RANGE` / `NO_TARGET` / `ROLE`)와 emoji 브로드캐스트 이벤트.
2. **`lobby.setLoadout` 검증을 실제로 구현한다.** 클라이언트 payload와 서버 검증을 하나로 맞춘다
   (`control`을 계약에 넣든지, 클라이언트가 빼든지 — **둘 중 하나로 정하고 shared에 적는다**).
3. **키보드 배선**: `movementSkill` 키 → `{ slot: 2 }`, `switchN` 키 → `{ slot: 1, targetPlayerId: N-1 }`,
   `emojiN` 키 → `game.emoji { emojiId: N-1 }`. `heldActions` 비트 정의를 shared에 명시하고 클라이언트가 채운다.
4. **`hud.switchTargets`를 실제로 계산하고 `onSwitchTarget`을 `GamePage`에서 넘긴다.** 클릭과 키보드가
   같은 경로로 가야 한다. 지목 가능 조건은 서버 규칙과 같다 — 살아 있고, 술래가 아니고, 자기 자신이 아니다.
5. **HUD 쿨타임을 서버 값으로 표시한다.** 1번의 self 섹션을 읽는다. 추측하지 않는다.
6. **실패 사유를 화면에 띄운다.** `AlertStack`이 이미 있다. "사거리 밖", "대상 없음" 정도면 충분하다.
7. `game.emoji`를 브로드캐스트한다. 게임 판정에는 영향이 없지만 남에게 보여야 의미가 있다.

**완료 조건**: 실제 경기에서 키보드로 스위치와 이동 스킬을 쓰고, 지목 가능한 사람의 번호 칩이 실제로 켜지고,
쿨타임이 서버 값으로 HUD에 돌고, 사거리 밖에서 누르면 이유가 뜬다. 로비에서 고른 스킬이 그 경기에 적용된다.
이모지가 상대 화면에 보인다. 설정에서 키를 바꾸면 그 키로 된다.

> **T5·T6의 선행이다.** 도움말이 키를 설명하고 훈련장이 스킬을 연습시키는데, 그 스킬이 안 나가면 둘 다 의미가 없다.

---

## T1. 테스트 러너 통일과 루트 `npm test` — 완료 (a870c1f)

`scripts/run-tests.cjs`(디렉터리 + `--suffix` 인자, 재귀 탐색 후 이름순 정렬해 `node --test`에 명시적으로 전달,
발견 0개는 실패)와 `scripts/run-workspaces.cjs`(순차 실행, `&&` 체이닝이 PowerShell에서 깨지는 것을 회피)를
루트에 두고 세 워크스페이스가 같은 러너를 쓴다. 루트에 `test`/`typecheck`/`build`, client에 `typecheck`를 넣었다.

**검증**: 루트 `npm test` 3회 반복에서 발견 파일 수가 매번 3/19/8(총 30개, 사전에 직접 센 개수와 일치).
shared 34 / server-game 119 / server-match 25 통과, 1 skip은 DB opt-in 통합 테스트(T10에서 처리한다).

<details><summary>원래 지시 내용</summary>

**왜**: `server-game`은 `scripts/run-tests.cjs`로 결정론적 나열을 하는데, `shared`와 `server-match`는 아직
셸 glob(`"dist-test/**/*.test.js"`, `dist/**/*.spec.js`)이다. X 라운드에서 같은 명령이 실행마다 다른 개수를
잡는 것을 확인한 그 문제가 두 워크스페이스에 그대로 남아 있다. 앞으로의 모든 작업이 이 그물 위에서 돈다.

**할 것**

- `server-game/scripts/run-tests.cjs`를 재사용 가능한 형태로 옮긴다(루트 `scripts/run-tests.cjs`에 두고
  대상 디렉터리와 접미사 `.test.js`/`.spec.js`를 인자로 받는다). 세 워크스페이스가 같은 러너를 쓴다.
- 발견 0개면 실패시키고, 발견/실행 파일 수를 항상 로그에 남긴다.
- 루트 `package.json`에 `test`(shared → server-game → server-match 순차), `typecheck`, `build`를 넣는다.
  `client`에도 `typecheck` 스크립트를 넣어 루트에서 같이 돈다.

**완료 조건**: 루트 `npm test`를 10회 반복해 매번 같은 파일 수·같은 테스트 수가 나온다.

</details>

---

## T2. 이메일 테스트 모드 — 완료 (3cda80d)

`EMAIL_TRANSPORT=smtp|sink`. sink는 `test:mail:{to}`에 `{kind, subject, code, sentAt}`을 TTL 600초로 넣고
아무것도 보내지 않는다. `GET /health`의 `email`이 `ok | checking | unconfigured | unreachable`을 보고한다.
`APP_ENV=prod` + sink는 기동 거부. `.env.example` 기본값은 sink다.

**검토에서 고친 것**: `onModuleInit`이 `verify()`를 await 해 Nest 부팅을 막고 있었다. transport에 타임아웃이
없어 nodemailer 기본값(connection 2분)까지 매달리므로, 네트워크 없는 CI나 방화벽 뒤에서 서버가 몇 분씩 안 뜬다.
await를 걷고 `checking` 상태를 추가했으며 SMTP 타임아웃을 10/10/20초로 명시했다. 회귀 테스트 2개를 붙였다.

**T8이 읽을 것**: 인증 코드는 Redis `test:mail:{to}`의 JSON `code` 필드다. 조회용 HTTP 엔드포인트는 없다.

<details><summary>원래 지시 내용</summary>

**왜**: 지금 SMTP가 실제 Gmail로 뚫려 있어서, 가입/탈퇴 흐름을 테스트할 때마다 존재하지 않는 주소로 메일이
나가고 반송이 사용자에게 온다. T8(E2E)이 인증 코드를 읽어야 하는데 지금은 Redis를 직접 뒤지는 수밖에 없다.

**할 것**

- `EMAIL_TRANSPORT=smtp|sink` 환경변수를 `EmailModule`에 넣는다. `sink`는 메일을 보내지 않고 Redis
  `test:mail:{to}` 리스트에 `{kind, subject, code, sentAt}`을 TTL 10분으로 push한다.
- **연결 검사는 sink 모드에서도 한다.** 기동 시 `transporter.verify()`를 한 번 돌려 결과를 `GET /health`의
  `email: 'ok' | 'unconfigured' | 'unreachable'`로 노출한다. 보내지 않으면서 "메일 서버가 살아 있는가"는
  확인된다.
- **안전장치**: `APP_ENV=prod`인데 `EMAIL_TRANSPORT=sink`면 기동을 거부한다. sink 조회 엔드포인트를 만든다면
  `APP_ENV !== 'prod'`에서만 등록하고, 인증 코드는 응답 본문·로그에 그대로 남기지 않는다(E2E는 Redis에서 직접 읽는다).
- `EmailService`의 세 메서드는 지금 HTML 본문이 통째로 복사돼 있다. transport 분기를 넣는 김에 템플릿 하나에
  제목·문구만 다르게 넣는 형태로 합친다.
- `.env.example`에 `EMAIL_TRANSPORT` 기본값 `sink`를 넣는다. **로컬 기본이 sink여야 사고가 안 난다.**

**완료 조건**: sink 모드에서 가입 → 코드 수신(Redis) → 인증 완료가 되고, 실제 메일함에는 아무것도 안 온다.
`GET /health`가 SMTP 연결 상태를 정확히 보고한다.

</details>

---

## T3. 통계 연결

**왜**: 결과는 이미 DB에 쌓인다(`users.stats` jsonb 누적 + `match_participants` 행). 그런데 **읽는 경로가 하나도
없다.** 지금 끊어져 있는 곳이 셋이다.

1. `client/src/api/matches.ts`의 `getMatchResult()`가 `GET /matches/:id/result`를 부르는데 **server-match에
   그런 라우트가 없다.** `matchApiEnabled`가 false면 `data/demoMatch.ts`의 가짜 결과가 화면에 나온다.
2. `ProfilePage`는 로그인 여부와 무관하게 `profile.statsPending`("준비 중") 문구만 띄운다.
3. 로비의 `LobbyPlayerStats`(전적·승률·스위치 성공률)는 게임 서버까지 배선돼 있지만
   (`ticket-store.ts` → `lobby-state.ts`), **server-match가 방 참가 명령에 stats를 실어 보내지 않아** 항상 `null`이다.

**할 것**

- server-match에 `MatchesModule`을 만든다.
  - `GET /matches/:matchId/result` — `MatchResultSnapshot` 형태 그대로. 참가자였거나 공개 경기면 조회 가능.
  - `GET /users/me/stats` (`@NeedAccount`) — 누적 전적 + 파생값(승률, 스위치 성공률, 평균 생존).
  - `GET /users/me/matches?limit&cursor` (`@NeedAccount`) — 최근 경기 목록. 커서는 `(playedAt, matchId)`.
- **shared 계약 변경(Claude)**: 방 생성·참가 명령에 `stats: LobbyStats | null`을 추가한다. server-match가
  참가자 계정의 stats를 채워 보내고 게스트는 `null`이다. `command-consumer.ts:277`(방장 경로)도 같이 채운다.
- 클라이언트: `api/stats.ts`를 추가하고 `ProfilePage`의 `statsPending` 자리에 실제 카드 + 최근 경기 목록을
  넣는다. 게스트에게는 "계정을 만들면 전적이 남는다"를 보여준다.
- **`data/demoMatch.ts`와 `matchApiEnabled`/`roomApiEnabled` 플래그를 제거한다.** 서버가 없을 때 가짜 결과를
  진짜처럼 보여주는 건 지금 시점에 득보다 실이 크다. 실패는 실패로 보여준다.

**완료 조건**: 경기를 한 판 끝내면 결과 화면이 실제 DB 값을 보여주고, 프로필의 누적 전적이 그만큼 늘고,
다음 로비에서 그 값이 카드에 뜬다. 게스트는 전적이 안 늘고 로비 카드에도 안 뜬다.

---

## T4. 리플레이 코덱을 `shared`로 (Claude)

**왜**: T7(브라우저 재생)의 전제. `server-game/src/replay/format.ts`가 `node:zlib`의 `gzipSync`와
`node:crypto`의 `createHash`를 직접 부른다. 브라우저에는 둘 다 없다.

**할 것**

- `shared/src/replay/format.ts`로 옮기고 압축·해시를 주입받게 한다.

  ```ts
  interface ReplayCodecEnv {
      gzip(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
      gunzip(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
      sha256(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  }
  ```

  Node 어댑터는 `zlib`/`crypto`, 브라우저 어댑터는 `DecompressionStream('gzip')`/`crypto.subtle.digest`.
- 파서는 여전히 **신뢰할 수 없는 입력**을 가정한다. 지금 있는 상한 검사(chunk 수, 해제 크기, offset, sha256)를
  하나도 빼지 않는다. 브라우저는 남의 파일을 여는 쪽이라 오히려 여기가 더 중요하다.
- `server-game/src/replay/`는 shared 코덱 + Node 어댑터를 쓰는 얇은 껍데기로 남는다. `recorder.ts`,
  `replay-store.ts`, `cli.ts`는 그대로 둔다.
- `REPLAY_CONTAINER_VERSION`은 그대로 1이다. 형식이 안 바뀌므로 기존 파일이 계속 열려야 한다.

**완료 조건**: 기존 `format.test.ts`가 shared에서 그대로 통과하고, f20f354로 만든 실제 리플레이 파일이 Node
어댑터와 브라우저 어댑터 양쪽에서 같은 프레임을 낸다.

---

## T5. 도움말 화면 리뉴얼

**왜**: `HowToPlayPage.tsx`는 39줄짜리 정적 카드 4장이고 키를 `'W A S D'`, `'SPACE'`, `'1 — 8'`로 **하드코딩**한다.
설정에서 키를 바꾼 사람에게는 거짓말이다. `useSettingsStore`에 `keyBindings`와 `KEY_ACTIONS` 22개가 이미 있는데
도움말이 그걸 안 읽는다.

**할 것**

- 키 표시는 전부 `keyBindings`에서 읽는다. `'KeyW'`/`'Shift+Digit1'` 같은 코드를 사람이 읽는 라벨로 바꾸는
  `formatKeyBinding(code, locale)`을 `client/src/utils/`에 하나 만들어 도움말과 설정 화면이 같이 쓴다
  (설정 화면에 이미 비슷한 변환이 있으면 그쪽으로 통일한다). 두 번째 슬롯이 있으면 `W / ↑`처럼 같이 보인다.
- 스킬 설명은 카드가 아니라 **움직이는 데모**로 만든다. 유체화(대시), 점멸, 탈진, 스위치(술래 넘기기),
  자기장 축소, 수풀·연막 은신 — 여섯 개의 짧은 루프.
  - 구현은 **`SwitchEngine`을 작은 캔버스로 띄우고 스크립트된 스냅샷을 먹이는 방식**을 우선 검토한다. 실제
    렌더러가 그리므로 이펙트가 게임과 어긋나지 않는다. 무거우면 SVG/CSS 루프로 내려가되, 그때는 "실제와 다를 수
    있다"를 감수한 결정이라는 주석을 남긴다.
  - `motionLevel === 'reduced'`와 `prefers-reduced-motion`이면 정지 프레임으로 대체하고 `reduceFlash`도 존중한다.
    도움말은 접근성 설정을 가장 먼저 지켜야 하는 화면이다.
- 하단 버튼은 `/sandbox` 대신 **훈련장(T6)** 으로 간다. 도움말에서 바로 몸으로 익히는 동선.
- 문구는 `locales/ko.json`·`en.json` 양쪽에 넣는다. 지금의 `guide.*` 키를 확장한다.

**완료 조건**: 설정에서 이동키를 바꾸면 도움말 표시가 즉시 따라 바뀐다. 데모 6종이 돌고 reduced motion에서 멈춘다.
ko/en 둘 다 빠진 문구가 없다.

---

## T6. 훈련장

**왜**: 지금 `/sandbox`(`EngineSandboxPage.tsx`, 764줄)는 **클라이언트가 자기 물리를 다시 구현한 목업**이다.
이동, 충돌, 속도 배율, 시야 근접 창까지 서버 시뮬레이션과 별개로 들어 있고 이미 값이 갈라져 있다
(`BASE_SPEED = 820`, `EFFECT_DEF`의 배율·지속시간이 `config/gameplay.ts`와 무관하다). 여기에 기능을 더 얹으면
갈라짐만 커진다. 훈련장은 **진짜 시뮬레이션 위에서** 돌아야 한다.

**설계 결정: 게임 서버의 방 모드로 만든다.**

로컬(브라우저 안) 실행도 가능은 하다 — `server-game/src/simulation/`은 `shared`와 `config` 외에 아무것도 import
하지 않아서 Vite로 번들이 된다. 그런데 그러면 네트워크 구간(스냅샷 인코딩, 시야 필터링, 보간, 지연)이 통째로
빠져서 **훈련장의 감각이 실제 경기와 달라진다.** 스킬 타이밍을 익히는 게 목적인 화면에서 그건 치명적이다.

**할 것**

- 방에 `mode: 'match' | 'training'`을 추가한다(shared 계약 — Claude). training 방은
  - 정원 1명, `minPlayers = 1`, 시작 잠금 없음, 경기 결과를 **outbox로 보내지 않는다**(전적 오염 금지).
  - 공개 방 목록에 뜨지 않고, 한 계정·게스트당 하나만. 게스트도 쓸 수 있다.
- **훈련 맵**: `tools/MapBuilder`로 `barrier_speed = 0`, timeline 비어 있는 맵을 하나 만든다. `storm.ts`의
  `stormInset = tick * barrierSpeed`가 0이 되어 자기장이 그대로 멈춘다 — **시뮬레이션 코드는 한 줄도 안 고쳐도 된다.**
  수풀과 연막 구역을 넉넉히 넣어 시야를 시험할 수 있게 한다.
- **더미**: 서버가 방에 스크립트 봇을 넣는다. 봇도 그냥 `PlayerState`다 — `ResolvedInput`을 사람 대신 경로
  추종기가 만들어 준다. 웨이포인트 루프를 돌고 잡히면 잠깐 뒤 리스폰한다. **봇 로직은 `simulation/` 밖에 둔다**
  (시뮬레이션은 입력을 받을 뿐 누가 만들었는지 몰라야 한다).
- **특수 블록**: `TilePhysics`에 새 값을 넣지 **않는다.** 그 enum은 모든 맵과 시야 계산이 공유하는 와이어
  계약이고, 훈련장 전용 개념을 거기 넣으면 전체가 넓어진다. 대신 훈련 맵 메타데이터에 패드 목록을 둔다.

  ```
  pads: [{ x, y, w, h, action: 'becomeTagger' | 'setSkill:dash' | 'setSkill:flash' | 'setSkill:exhaust' | 'reset' }]
  ```

  서버가 매 tick 밟았는지 검사해 효과를 적용하고, 클라이언트는 training 모드에서만 오버레이로 그린다.
- 인게임에서 설정을 여는 경로가 훈련장에도 있어야 한다(`SettingsDock` 재사용). 바꾼 값이 즉시 반영되는지가
  훈련장의 목적 중 하나다.
- **`/sandbox`는 훈련장이 생기면 지운다.** 렌더러 단독 확인이 계속 필요하면 목업 물리를 뺀 "스냅샷 fixture를
  먹여 그림만 보는" 100줄짜리로 줄여 남긴다. 지금의 764줄 목업 시뮬레이션은 유지 비용만 남는다.

**완료 조건**: 도움말 → 훈련장으로 혼자 들어가 움직이고, 봇을 잡고, 패드를 밟아 술래가 되거나 스킬을 바꾸고,
수풀에 들어가면 봇 시야에서 사라지고, 자기장이 끝까지 안 줄고, 설정을 열어 바꾼 값이 바로 보인다.
훈련 경기가 `matches`·`match_participants`에 한 행도 안 남는다.

---

## T7. 리플레이 로컬 재생기

**왜**: 지금은 `npm run replay:inspect`(텍스트 CLI)뿐이다. `REPLAY.md` 11절의 재생은 아직 없다.

**할 것**

- 클라이언트에 `/replay` 라우트를 추가한다. **서버 없이 도는 화면이어야 한다** — `.swr` 파일을 드래그&드롭하거나
  파일 선택으로 열고, T4의 브라우저 어댑터로 파싱한 뒤 `SwitchEngine`에 프레임을 먹인다.
- 컨트롤: 재생·일시정지, 배속(0.25×~4×), 프레임 단위 이동, 타임라인 시크(chunk 첫 프레임이 항상 full 스냅샷이라
  처음부터 되감지 않고 해당 chunk만 풀면 된다), 뷰어 전환(`unfiltered` ↔ 특정 플레이어 시야 bitmask).
- 맵은 manifest의 `mapId`/`mapBundleHash`로 정해진다. 서버가 없을 수도 있으므로 (a) `/map-bundles/`에서 받아오고
  (b) 실패하면 번들 파일을 직접 열게 한다. 해시 검증은 `GamePage`의 `verifiedMapView()`와 같은 것을 쓴다 —
  그 함수를 `client/src/game/`으로 빼서 공유한다.
- 파싱은 워커에서 돌린다. 5분 경기 원본이 ~1MB지만 gunzip이 메인 스레드를 잡으면 재생이 튄다.
- **Electron 같은 별도 앱은 만들지 않는다.** 렌더러가 이미 브라우저에 있는데 껍데기를 하나 더 만들 이유가 없다.
  "로컬 프로그램"이 필요하면 `npm run replay:web`이 정적 빌드를 띄우는 것으로 충분하다.

**완료 조건**: 실제 경기 리플레이를 열어 끝까지 재생하고, 시크가 맞고, 뷰어를 바꾸면 그 사람이 본 것만 보인다.
잘린 파일·변조된 chunk를 열면 화면이 깨지지 않고 오류 메시지가 뜬다.

---

## T8. 브라우저 E2E 자동화

**왜**: 지금 검증은 단위 테스트 + 사람이 브라우저 둘을 켜는 것뿐이다. X 라운드에서 나온 버그 대부분(맵 미로드,
결과 미저장, 방 코드 불일치)은 단위 테스트가 잡을 수 없는 **계층 사이**의 것이었다.

**할 것**

- `e2e/` 워크스페이스를 새로 만든다. Playwright(Chromium). 시나리오는 실제 사용자 동선 순서대로.
  1. 첫 방문 → 게스트 세션 자동 발급 → 방 목록이 401 없이 뜬다
  2. 회원가입 → (sink에서 코드 읽기) → 인증 → 로그인 → 프로필
  3. 방 생성 → 두 번째 브라우저 컨텍스트가 **방 코드로** 참가 → 세 번째는 빠른 참가
  4. 로비: 맵 변경, 스킬 로드아웃, 준비, 시작
  5. 인게임: 이동 입력, 스킬 사용, 태그 성사, 한 명 이상 탈락
  6. 경기 중 F5 → 같은 방으로 복구
  7. 경기 종료 → 결과 화면 → 프로필 전적 증가 → 리플레이 파일 생성 확인
  8. 훈련장 진입·이탈(T6 뒤)
  9. 설정 변경 지속(F5 후에도 유지), 언어 전환, 테마 전환
  10. 계정 삭제 → (sink 코드) → 삭제 후 로그인 불가
- **이메일은 T2의 sink로만 읽는다. 실제 발송 0건.**
- 실패 시 스크린샷·트레이스·서버 로그를 아티팩트로 남긴다. 콘솔 에러와 미처리 네트워크 실패는 그 자체로 실패다.
- **리포트 메일**: 마지막에 결과 요약(통과·실패 수, 소요, 실패 시나리오, 커밋 해시)을 **실제 SMTP로**
  `seolchaehwan70@gmail.com`에 한 통 보낸다. 이게 "메일 서버가 실제로 살아 있다"의 증거이자 유일한 실발송이다.
  `--report-email` 플래그가 있을 때만 보낸다(기본은 안 보냄).
- 서버 기동·정리는 스크립트가 맡는다. Postgres/Redis는 `docker compose`, 두 서버는 빌드 후 실행, 클라이언트는
  `vite preview`. **테스트 DB는 개발 DB와 분리한다** — 계정 삭제 시나리오가 있다.

**완료 조건**: `npm run e2e`가 깨끗한 체크아웃에서 처음부터 끝까지 돌고 리포트 메일이 도착한다.
시나리오 하나를 일부러 깨뜨리면 실패로 잡힌다.

---

## T9. 클라이언트 점검

Claude가 정적으로 훑어 확인한 것들. 각각 독립 커밋이면 좋다.

**끊긴 기능**

- **소리가 아예 없다.** 설정에 마스터·BGM·효과음 슬라이더 3개가 있는데 `masterVolume`/`bgmVolume`/`sfxVolume`을
  읽는 코드가 클라이언트 전체에 하나도 없다. 오디오 시스템을 만들든지, 만들 때까지 슬라이더를 감추든지 정한다.
  (권장: 지금은 감춘다. 없는 기능의 스위치가 설정에 있는 게 더 나쁘다.)
- 가짜 데이터 폴백 — T3에서 같이 정리한다(`demoMatch.ts`, `matchApiEnabled`, `roomApiEnabled`).
- `LobbyPage`가 `useParams()` 기본값으로 `DEMO_LOBBY.roomId`를 쓴다. 라우트가 `:roomId`라 실제로 걸리진 않지만,
  없는 방을 데모 방으로 눌러 앉히는 형태라 지운다.

**없는 화면**

- 최근 경기 목록·전적 상세(T3), 리플레이 재생(T7), 훈련장(T6).
- ErrorBoundary가 없다. 렌더 중 예외가 나면 흰 화면이다. 최소한 루트에 하나.
- 404가 무조건 `/`로 리다이렉트된다. 잘못된 방 코드로 들어온 사람이 아무 설명 없이 타이틀로 튕긴다.

**클라이언트에 테스트가 0개다**

`client`에 `test` 스크립트도 테스트 파일도 없다. T8이 큰 그물을 치더라도 순수 함수는 단위로 잡는 게 싸다.
최소한 `utils/validation.ts`, `formatKeyBinding`(T5), 스냅샷→HUD 변환은 테스트가 있어야 한다. Vitest 도입을 검토한다.

**성능**

- `MapLayer`가 정적 레이어를 캐시하는지 매 프레임 다시 그리는지 확인한다(`quality.ambientFrameSkip`이 있는 걸 보면
  일부는 하고 있다). **8인 풀방 + 연막에서 프레임을 실측한다 — 지금까지 3인 경기밖에 안 돌렸다.**
- `resolutionScale`/`frameRate`/`graphicsQuality`가 실제로 렌더 비용을 바꾸는지 수치로 확인한다. 배선은 돼 있다.
- 리플레이 gunzip은 워커로(T7).

**UI 판단이 필요한 것** (사용자 확인 후 진행)

- 로비의 스킬 선택이 지금 팝오버다. 훈련장이 생기면 "골라서 바로 시험"하는 동선이 자연스러워진다.
- 결과 화면의 승자 2인 표기 — 동시 탈락으로 1명만 남으면 같은 사람이 두 번 들어간다(서버의 의도된 동작).
  화면에서 어떻게 보일지 정해야 한다.

---

## T10. 테스트 정리 (T8 뒤에)

**먼저 사실 관계**: 지금 테스트는 **30개 파일 약 180개**다. 이 규모의 코드베이스에서 많은 편이 아니다. "너무
많다"는 느낌의 원인은 개수가 아니라 (a) 실행이 불안정했던 것(T1에서 해결) (b) 값이 낮은 파일이 눈에 띄는 것
(c) E2E가 없어서 단위 테스트가 실제 동작을 보증하지 못한 것에 가깝다. **일괄 삭감은 권하지 않는다.**

**기준을 정해 그 기준으로만 줄인다**

| 남긴다 | 지운다·합친다 |
| --- | --- |
| 와이어 계약 (`shared/protocol/*`, 결과 코덱, 컨트롤 스트림) | 구현 세부를 그대로 베낀 단언 |
| 규칙 (`simulation/skills`, `step`, 시야 코어) | T8 E2E가 같은 경로를 더 진짜로 덮는 것 |
| 파서의 악의적 입력 방어 (`replay/format`, `map-loader`) | 파일 하나에 테스트 1~2개뿐인 조각 |
| 회귀 — X 라운드에서 실제로 났던 버그 | 프레임워크 동작을 확인하는 것 |

**구체 후보**

- `gateway/connection-manager.test.ts`(1개/15줄), `gateway/message-router.test.ts`(2개/19줄),
  `gateway/rate-limit.test.ts`(1개/16줄) → `gateway/gateway.test.ts` 하나로 합친다. 커버리지 그대로, 파일 3개 감소.
- `rooms/room-manager.test.ts`(1개/100줄)가 `rooms/room.test.ts`와 겹치는지 확인해 겹치면 합친다.
- `simulation/skills.test.ts`(28개/387줄)는 **줄이지 않는다.** 게임 규칙 자체다.
- `results/result.service.integration.spec.ts`는 DB opt-in이라 평소 안 돈다. T8의 CI에서 실제로 돌게 붙이거나,
  안 돌 거면 지운다. **안 도는 테스트가 제일 나쁘다.**

**완료 조건**: 파일 수는 줄고 검증하는 동작 범위는 그대로다. 줄인 근거를 커밋 메시지에 남긴다.
T8이 전부 통과하는 상태에서만 머지한다.

---

## T11. 문서 정리

**먼저 사실 관계**: `docs/`는 5개 파일 2,600여 줄이다. 파일 수가 문제가 아니라 **한 문서 안에 "변하지 않는 설계"와
"이미 끝난 구현 순서·미결 사항"이 섞여 있는 것**이 문제다. 그래서 읽는 사람이 뭐가 현재 사실인지 모른다.

**할 것 (삭제가 아니라 분리)**

- `SERVER_ARCHITECTURE.md`(1,194줄): §23 구현 순서, §26 작업 분담 기준, §27 미결 사항을 걷어낸다. 큐는 이 문서에
  있어야 하고, 두 곳에 있으면 갈라진다. 해결된 미결은 본문 규칙으로 승격하고 안 해결된 것만 여기 T 항목으로 옮긴다.
- `REPLAY.md`: §12 구현 순서에서 끝난 3~6번을 "구현됨(f20f354)"으로 한 줄 처리하고 7번 이후만 남긴다.
  §14 미결 중 결정된 것을 본문에 반영한다.
- `ENGINE.md`: §7 유저 설정이 실제 `useSettingsStore`와 어긋난 부분을 대조한다(특히 소리 — T9 참고).
  문서에만 있고 코드에 없는 설정은 문서에서 지우거나 T 항목으로 만든다.
- `FUTURE.md`(435줄): 아직 아무것도 구현 안 된 미래 구상이다. **지우지 않는다** — 대신 맨 위에 "구현된 것 없음,
  결정 아님"을 한 줄로 못 박는다.
- 각 문서 맨 위에 `최종 검토: YYYY-MM-DD` 한 줄. 오래된 문서를 알아볼 수 있어야 한다.

**완료 조건**: 같은 사실이 두 문서에 다르게 적힌 곳이 없다. 큐는 `TASKS.md`에만 있다.

---

## R. 보안·오류 점검 라운드 (마지막)

T0~T11이 끝나고 코드가 더 안 움직일 때. 찾을 것이 "스펙 위반"이 아니라 **"그럴듯한데 틀린 것"** 이라서 마지막에 돈다.

- 티켓 검증의 원자적 소비와 실패 응답의 타이밍 차이
- Redis ACL 사용자 분리. 지금은 단일 비밀번호로 전부 접근 가능하다
- 세션 테이블 원본 IP의 보관 기간과 파기(`SESSION_IP_RETENTION_DAYS`가 실제로 도는지)
- 위반 신호(`ViolationSignal`)의 실제 소비자 연결
- 결정론 테스트와 가짜 클라이언트 부하 테스트
- 8인 풀방 tick 측정 후 프로세스당 방 수 상한 확정. `draining` 임계값과 연결 상한 확정
- outbox가 가득 찼을 때 신규 게임 시작 차단(`outbox.canStartNewGame`). 지금은 로그만 남기고 그 경기 전적이 유실된다
- `GameSession`이 방을 직접 참조한다. 지금은 메서드 6개만 쓰지만 늘어나면 경계가 새고 있다는 신호다
- `COMMAND_TIMEOUT_MS = 2000`에 근접하는 왕복 지연의 원인. **계측부터 하고 숫자를 만지지 않는다**
- 참가 빈도 제한과 timeout 재시도가 겹쳐 "그냥 못 들어가는" 상태가 되는 문제
- 리플레이: 시야 bitmask를 `writeVisibility`와 `publish()`가 각각 계산한다(값은 같고 계산은 두 번).
  `MemoryReplayRecorder`의 프로세스 상한 256MB는 실측 없이 잡은 값이다
- `replays`/`replay_holds` 보존·삭제 주기가 아무것도 안 돈다(`REPLAY.md` 7~10절)
- T2의 sink 모드가 prod에서 켜질 수 없는지 재확인
- T6 훈련장이 실경기 자원(방 수, tick 예산, 전적)으로 새지 않는지

---

## 부록: 로컬 실행

```bash
npm run db:up
npm run shared:build && npm run game:build
npm run match:dev      # 3000
npm run game:dev       # 4000 — GAME_SERVER_ID, GAME_MAP_BUNDLE(절대경로) 필요
npm run dev -w client  # 5173
```

인게임 서버는 cwd가 `server-game/`이라 `GAME_MAP_BUNDLE`에 상대경로를 쓰면 어긋난다. 나머지 변수는 `.env.example`.

## 부록: 테스트 계정

SMTP가 실제 Gmail로 뚫려 있어 존재하지 않는 도메인으로 보낸 메일이 반송된다. **T2가 끝나기 전에는 새 계정을
만들지 말고 아래를 재사용한다.**

| 이메일 | 비밀번호 | 닉네임 |
| --- | --- | --- |
| switch.tester1@example.com | TestPass123! | Player1 |
| switch.tester2@example.com | TestPass123! | Player2 |
| switch.tester3@example.com | TestPass123! | Player3 |

인증 코드는 메일로 안 오니 Redis에서 직접 읽는다: `auth:code:{vtype}:{email}` (`vtype`은 `signup`/`reset-password`/`delete`).
T2 이후에는 sink(`test:mail:{to}`)에서 읽는다.
