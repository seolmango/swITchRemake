# 기여 안내

처음이라면 [README](README.md)의 "로컬 개발"로 한 번 띄워 보고 여기로 온다. 무엇을 왜 그렇게 만드는지는
[BASE.md](BASE.md)에 있다.

## 흐름

1. `main`에서 브랜치를 딴다. 한 PR에는 한 가지 일만 담는다.
2. 고치는 동안 `npm run check`(타입·린트·단위 테스트, 1~2분)로 자주 확인한다.
3. 다 됐으면 `npm run verify`로 **표준**을 돌린다. GitHub Actions가 PR마다 돌리는 것과 같은 명령이다.
4. PR을 연다. **Verify**가 통과해야 합친다.
5. `main`에 합쳐지면 Verify가 다시 돌고, 통과한 커밋만 **Deploy** 워크플로가 배포한다(운영자가 승인).

## 표준 = 테스트

`npm run verify`가 통과하면 그 커밋은 배포할 수 있다. 내부 구현이 어떻게 바뀌었든 상관없다 — 사용자가
할 수 있어야 하는 조작, 견뎌야 하는 장애, 막아야 하는 공격을 이 검사가 정의한다. 그래서 동작을 바꾸면
테스트도 함께 바꾸고, 새 기능에는 새 흐름 점검을 붙인다. 검사를 지우거나 건너뛰게 해서 통과시키지 않는다.

`npm run verify`는 일회용 Docker 스택(DB·Redis·메일까지 전부 가짜, 바깥 네트워크 없음)을 만들어
정적 검사 → 단위 테스트 → 보안·장애 점검 → 실제 브라우저 흐름을 차례로 돌리고 스택을 지운다. Docker가 필요하다.

| 영역 | 무엇을 보나 |
| --- | --- |
| `static` | 배포·워크플로 정책, 타입 검사, 린트 |
| `unit` | 워크스페이스 단위 테스트, 밸런스 관계·규칙 버전, 설정 스키마 |
| `account` | 가입·로그인·비밀번호·2차 인증·세션·탈퇴 |
| `rooms` | 방 목록·생성·참가·대기실 |
| `match` | 경기·결과·리플레이·훈련장 |
| `client` | 첫 방문·설정·화면 배치(테마 × 화면 크기) |
| `admin` | 운영자 화면·신고·공지와 점검 |
| `security` | 출처·세션·티켓·결과 위조 방어, 외부 접속 차단, 결과 유실·방 이관 경합 |

```sh
npm run verify                     # 전부, 스택 하나
npm run verify -- account rooms    # 일부 영역만
npm run verify -- --parallel 2     # 스택 2개에 나눠 동시에(스택 하나가 메모리를 최대 약 6GB 쓴다)
npm run verify -- --plan           # 무엇이 어느 스택에서 돌지만 보여 준다
npm run verify:extended            # + 인게임 서버 증감·장애 주입 (GitHub에서는 매주 돈다)
```

GitHub의 Verify는 묶음(`scripts/verify/areas.cjs`의 `SHARDS`)마다 워커를 따로 받아 동시에 돌리고, 묶음마다
`npm run verify -- <영역>`을 부른다. 로컬과 같은 명령, 같은 기준이다. 모든 묶음이 통과하면 `passed` 검사가
통과한다 — 브랜치 보호의 필수 검사로는 이것 하나를 건다.

브라우저 흐름은 `e2e/specs/<영역>/`에 있다. 새 흐름은 맞는 폴더에 넣으면 그 영역에 들어간다.
실패하면 증거(요약·스크린샷)가 `e2e/artifacts/audit/<실행 id>/`에 남는다. 스택을 띄워 두고 한 파일씩
고쳐 보는 법은 [deploy/verify/README.md](deploy/verify/README.md)에 있다.

## 바꿀 때 함께 바꾸는 것

| 바꾸는 것 | 함께 할 일 |
| --- | --- |
| 게임 규칙·보안·운영 방식 | BASE.md를 먼저 고친다. 코드가 BASE.md와 다르면 코드가 틀린 것이다 |
| 화면 문구 | `client/src/locales/ko.json`과 `en.json` 둘 다. 한쪽만 있으면 버그다 |
| 서버 간·클라이언트 계약(`shared/`) | 양쪽을 같은 PR에서. 주고받는 형식이 깨지면 `PROTOCOL_VERSION`을 올린다 |
| DB 스키마(`server-match/src/database/schema.ts`) | `npm run db:generate -w server-match`로 마이그레이션을 만들어 `server-match/drizzle/`를 함께 커밋한다 |
| 환경 변수 | `scripts/env/schema.cjs`에 추가하고 `npm run env:docs` |
| 보존 기간 | 설정 기본값, BASE.md §14.1, `legal/` 개인정보처리방침을 함께 |
| 맵 | `npm run map:editor`로 고치고 빌드해 `server-game/maps/server_maps.json`까지 커밋 ([MapBuilder](tools/MapBuilder/README.md)) |
| 그 밖에 사용자가 알아챌 변경 | [CHANGELOG.md](CHANGELOG.md)의 "다음 배포"에 한 줄 |

## 밸런스 바꾸기

밸런스 값은 코드 파일에 있다. 대부분 `shared/src/protocol/tuning.ts`(스킬·이동)이고, 서버만 아는 값은
`server-game/src/config/gameplay.ts`, 경험치는 `shared/src/protocol/progression.ts`다. 지금 값은
[docs/balance.md](docs/balance.md)에서 한눈에 본다.

1. 값을 고친다.
2. `npm run dev`로 띄워 훈련장에서 직접 해 본다. 이때 서버의 규칙 버전은 `0.5.0-dev.1a2b3c4d`처럼 "아직
   릴리스하지 않음" 표시가 붙어, 시험 경기가 정식 버전으로 기록되지 않는다(타이틀 화면에도 보인다).
3. `npm run balance`로 바뀐 값과 지켜야 하는 관계(예: 유체화가 점멸보다 멀리 간다)를 확인한다.
4. 확정하면 `npm run balance:release -- -m "무엇을 왜"`. 버전이 올라가고 CHANGELOG에 바뀐 값이 적힌다.
   체감이 큰 조정은 `--minor`, 밸런스 테스트를 마친 첫 정식 규칙은 `--major`(→ 1.0.0).
5. `server-game/src/config/rules-lock.ts`, `CHANGELOG.md`, `docs/balance.md`를 값과 함께 커밋한다.

릴리스하지 않고 PR을 열면 Verify가 실패한다. `server-game/src/simulation/`의 코드를 고쳐도 같다 — 값이
그대로여도 움직임이 달라지면 다른 규칙이기 때문이다. 이전 경기의 리플레이는 기록된 위치를 그대로 재생하므로
규칙이 바뀌어도 깨지지 않는다.

## 커밋

`종류(범위): 무엇을` 형식을 쓴다. 종류는 `feat` `fix` `perf` `refactor` `test` `docs` `chore`, 범위는
`client` `game` `match` `gateway` `e2e` `deploy` `balance` 등. 제목은 무엇이 바뀌었는지를 한 줄로,
왜는 본문에 쓴다.

## 비밀값

`.env`, `.env.deploy`, 키 파일을 커밋하지 않는다(`.gitignore`가 막는다). `npm run verify`는 시작할 때
추적 중인 파일에서 비밀값 모양을 찾아 있으면 멈춘다.
