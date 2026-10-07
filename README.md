# swITch

브라우저에서 3~8명이 하는 실시간 술래잡기 게임이다. 술래에게 닿으면 탈락하고, 도망자는
**스위치**로 술래를 다른 사람에게 떠넘길 수 있으며, 맵은 자기장에 밀려 계속 좁아진다. 생존자가
2명 이하가 되면 남은 전원이 공동 승리한다. PC(키보드)와 모바일(터치)을 모두 지원한다.

- 무엇을 왜 그렇게 만드는지 — 게임 규칙, 신뢰 경계, 보안·운영 요구사항 — 는 **[BASE.md](BASE.md)
  하나에** 있다. 이 README는 코드를 어디서부터 읽고 어떻게 돌리는지만 다룬다.
- 형식(바이너리 스냅샷, JSON 메시지, 서버 간 명령)의 정의는 `shared/`의 타입이 원본이다.

## 구성

```text
                     ┌──────────── HTTP /api ───────────┐
 브라우저 ─(client)──┤                                  ▼
                     │                           server-match ── PostgreSQL
                     └─ WS /game-ws, /map-bundles,     │  ▲        (계정·세션·전적)
                        /replays                      명령 │ 결과
                              ▼                        ▼  │
                       server-gateway ─── 부하 보고 ── Redis ── server-supervisor
                              │                        ▲  │        (프로세스 증감)
                              ▼                        │  ▼
                       server-game × N ────────────────┘
                       (방·대기실·60Hz 시뮬레이션·스냅샷)
```

| 워크스페이스 | 역할 | 진입점 |
| --- | --- | --- |
| `shared/` | 모두가 쓰는 계약: 스냅샷·입력 인코딩, JSON 이벤트, Redis 제어 명령·결과, 시야 판정, 리플레이 형식, 로그인 사람 확인(PoW) | `src/index.ts` |
| `server-match/` | NestJS(Fastify). 인증·2차 인증·세션, 방 배정과 접속 티켓 발급, 전적·리플레이 다운로드, 신고·제재, 운영 API, 보관 기간 정리 | `src/main.ts`, `src/app.module.ts` |
| `server-game/` | 인게임 서버. 방과 대기실을 소유하고 게임 루프를 돌려 연결별로 검열한 스냅샷을 보낸다. 결과는 Redis로 내보낸다 | `src/main.ts` |
| `server-gateway/` | 외부에 보이는 유일한 게임 주소. Redis의 부하 보고를 검증해 `/game-ws/<serverId>` 등을 해당 인게임 서버로 넘긴다 | `src/main.ts` |
| `server-supervisor/` | 부하를 보고 인게임 서버 프로세스를 띄우고 drain으로 줄인다 | `src/main.ts`, `src/policy.ts` |
| `client/` | React SPA + Phaser 렌더러. 화면은 `src/pages/`, 인게임 엔진은 `src/game/` | `src/main.tsx`, `src/App.tsx` |

한 판의 흐름은 다음과 같다.

1. 클라이언트가 `/api`(매칭 서버)로 로그인하거나 게스트 신원을 받는다.
2. 방 생성·참가 요청을 받은 매칭 서버가 Redis의 heartbeat로 부하가 적은 인게임 서버를 고르고,
   Redis 명령 스트림으로 방 생성·자리 예약을 지시한다. 인게임 서버는 일회용 티켓을 돌려준다.
3. 클라이언트는 게이트웨이를 거쳐 그 인게임 서버에 WebSocket으로 붙고 첫 메시지로 티켓을 낸다.
4. 경기 중 클라이언트는 눌린 버튼만 보낸다. 서버가 60Hz로 판정하고(`server-game/src/simulation`),
   연결마다 시야를 검열한 바이너리 스냅샷(`shared/src/protocol/snapshot.ts`)을 더 낮은 주기로 보낸다.
5. 경기가 끝나면 인게임 서버가 결과를 디스크 저널에 남긴 뒤 Redis 결과 스트림으로 보내고,
   매칭 서버가 PostgreSQL에 저장한 다음 다음 경기 식별자를 내려 준다.

### 코드 읽는 순서

- **게임 규칙**: `server-game/src/simulation/step.ts`(한 틱의 순서) → `movement.ts`, `skills.ts`,
  `effects.ts`, `storm.ts` → 밸런스 값 `server-game/src/config/gameplay.ts`, `shared/src/protocol/tuning.ts`.
- **방과 연결**: `server-game/src/rooms/room.ts`(대기실·상태 전이) → `game/game-session.ts`(루프와 방의 연결)
  → `game/snapshot-view.ts`(권위 프레임 → 연결별 스냅샷). `server-game/src/gateway/`는 티켓 인증·메시지
  파싱·연결 제한이다(`server-gateway` 프로세스와는 다르다).
- **서버 간 계약**: `shared/src/control/commands.ts`(매칭 → 인게임 명령, Redis 키), `results.ts`(경기 결과).
- **매칭 서버**: `server-match/src/rooms/rooms.service.ts`(배정), `auth/`, `results/result.worker.ts`(결과 저장),
  DB 스키마 `database/schema.ts`와 마이그레이션 `drizzle/`.
- **클라이언트 엔진**: `client/src/game/index.ts`가 렌더링 엔진의 표면이고, `SwitchGame.tsx`가 React HUD와
  Phaser(`internal/WorldScene.ts`)를 잇는다. 서버 연결은 `GameSession.ts`, 화면 흐름은 `client/src/App.tsx`의 라우트.

## 필요한 것

- Node.js 24, npm 11
- Docker (개발용 PostgreSQL·Redis, 그리고 `npm run verify`)
- 선택: Python 3(맵 빌드), ffmpeg(`npm run audio:build`)

## 로컬 개발

```bash
npm install          # shared는 설치하면서 자동 빌드된다
npm run setup        # .env를 만들고 비밀값을 채운다(이미 있으면 빠진 항목만 덧붙인다)
npm run db:up        # PostgreSQL + Redis (docker-compose.yml)
npm run db:migrate
npm run dev          # 매칭 서버 :3000, 게이트웨이+인게임 :4100, 클라이언트 :5173을 한 번에
```

http://localhost:5173 에 접속한다. `npm run dev`는 띄우기 전에 .env, DB·Redis 접속, 남은 마이그레이션을
확인하고 무엇을 먼저 할지 알려 준다. Ctrl+C 한 번이면 전부 내려간다.

- 클라이언트와 매칭 서버는 저장하면 바로 반영된다. 인게임·게이트웨이 쪽(`server-game` 등)을 고쳤으면 `npm run dev`를
  다시 띄운다(띄울 때 빌드한다). `shared/`는 클라이언트가 소스를 직접 읽고, 서버용 빌드는 `npm run shared:build`.
- 하나씩 띄우려면 `npm run match:dev`, `npm run cluster:start`, `npm run dev -w client`.
- 운영자 화면(`/admin`)은 가입한 계정을 `npm run admin:grant -- <email>`로 승격해서 쓴다.
- 메일은 보내지 않는다(`EMAIL_TRANSPORT=sink`). 가입·재설정 인증 코드는 Redis의 `test:mail:{용도}:{email}`
  키에서 본다.

설정 항목 전체와 각 값의 뜻은 [docs/configuration.md](docs/configuration.md)에 있다. 직접 적지 않고
`npm run setup`(로컬) / `npm run setup -- deploy`(배포)로 만들고, `npm run env:check`로 검사한다.

## 고치고 확인하기

| 명령 | 무엇 | 걸리는 시간 |
| --- | --- | --- |
| `npm run check` | 타입 검사, 린트, 단위 테스트 | 약 1분 |
| `npm run verify` | **표준 전체.** 일회용 Docker 스택에서 위 전부 + 보안·장애 점검 + 실제 브라우저로 모든 사용자 흐름. GitHub의 Verify와 같은 명령이고, 이게 통과한 커밋만 배포된다 | 수십 분 |
| `npm run verify -- account rooms` | 표준의 일부 영역만 | |
| `npm run verify -- --parallel 2` | 스택 2개에 나눠 동시에. 메모리가 넉넉할 때(스택당 최대 약 6GB) | |

영역과 규칙은 [CONTRIBUTING.md](CONTRIBUTING.md)에 있다.

**밸런스**는 `shared/src/protocol/tuning.ts` 등의 값을 고치고 훈련장에서 해 본 뒤 `npm run balance:release`로
규칙 버전을 올린다. 버전이 경기 결과·리플레이·타이틀 화면에 찍히고 [CHANGELOG.md](CHANGELOG.md)에 바뀐 값이
남는다. 지금 값은 [docs/balance.md](docs/balance.md). 자세한 절차는 [CONTRIBUTING.md](CONTRIBUTING.md#밸런스-바꾸기).

**맵**은 `npm run map:editor`로 고친다([tools/MapBuilder](tools/MapBuilder/README.md)).

## 배포

`Dockerfile.backend`(서버 4종)와 `deploy/Dockerfile.web`(nginx + 클라이언트) 두 이미지를 Docker Compose로 띄운다.

- **서버 한 대에 직접**: `npm run setup -- deploy`(도메인·메일 계정을 묻는다) 뒤 `npm run stack:up`. 도메인을
  주면 HTTPS 인증서까지 자동이다.
- **Azure 운영 서버**: `main`에 합쳐진 커밋의 Verify가 통과하면 GitHub의 Deploy 워크플로가 배포한다.

절차와 주의점은 [docs/deployment.md](docs/deployment.md).

## 디렉터리

| 경로 | 내용 |
| --- | --- |
| `BASE.md` | 요구사항·설계 결정의 유일한 문서 |
| `CONTRIBUTING.md` | 작업 흐름, 표준(테스트), 함께 바꿀 것, 밸런스 바꾸는 법 |
| `CHANGELOG.md` | 업데이트 기록. 규칙(밸런스) 버전 기록은 자동으로 쌓인다 |
| `docs/` | `deployment.md`(배포), `configuration.md`·`balance.md`(생성 문서), `audit-2026-10-04/`(지난 감사와 배포 기록) |
| `legal/` | 이용약관·개인정보처리방침 원문(클라이언트가 그대로 보여 준다) |
| `server-game/maps/server_maps.json` | 맵 번들. `tools/MapBuilder`가 만들고 서버 이미지에 들어간다 |
| `tools/MapBuilder/` | 맵 원본, 빌더, 에디터 |
| `e2e/` | 브라우저 흐름 점검. `specs/<영역>/` ([README](e2e/README.md)) |
| `scripts/` | `dev`·`deploy-stack`·`start-*`(실행), `env/`(설정 생성·검사), `balance/`(규칙 버전), `verify/`(표준 실행), `build-*`·`grant-admin`·`replay-keygen`(도구) |
| `deploy/` | `compose.yml`·`Caddyfile`(배포 스택), `nginx.conf`·`Dockerfile.web`, `verify/`(검증 스택), `azure/`(운영 서버) |
| `docker-compose.yml` | 개발용 DB/Redis만 |
| `.github/workflows/` | `verify.yml`(표준), `deploy.yml`(검증된 커밋만 배포) |

## 주의할 점

- 인게임 서버 프로세스가 죽거나 교체되면 그 프로세스의 방은 끝난다. 게임 상태는 메모리에만 있다. 그래서
  배포는 서버에 사람이 없을 때만 진행된다.
- 리플레이 저장소는 로컬 디스크만 구현돼 있다(`REPLAY_STORE=local`).
- 클라이언트가 맵 번들 무결성과 리플레이 서명을 `crypto.subtle`로 검증하므로, localhost가 아닌 주소는
  HTTPS여야 한다.
- 버전은 아직 0.x다. 밸런스 테스트를 마친 첫 규칙이 1.0.0이 된다.
- 저장소의 라이선스는 아직 정하지 않았다(BASE.md §14.7).
