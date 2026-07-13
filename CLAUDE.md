# CLAUDE.md — swITch 작업 가이드

AI 에이전트가 이 레포에서 작업할 때 지켜야 할 규칙과 맥락. 매 세션 로드되므로 간결하게 유지한다.

## 프로젝트

swITch는 실시간 멀티플레이어 **술래잡기(tag)** io 게임이다. 3~8명 개인전, 술래가 계속 바뀌고 자기장으로 맵이 좁아진다. 과거에 완성했다가 **확장성·트래픽 병목**으로 갈아엎은 이력이 있어(→ `legacy/`), 이번 재작성의 설계는 대부분 그 문제를 피하기 위한 것이다.

**설계 최종 진실은 `docs/`에 있다. 게임/구조 관련 판단 전에 반드시 참고할 것:**
- `docs/GAME_DESIGN.md` — 규칙·역할·속도공식·스킬·자기장·타일·스탯·상수
- `docs/ARCHITECTURE.md` — 레포 구조·서버 분리·인증/세션·매치메이킹·방 생명주기·네트코드 불변식
- `docs/API_SPEC.md` — 매치서버 REST 엔드포인트(인증·계정·매치메이킹)
- `docs/WS_PROTOCOL.md` — 게임서버 WebSocket 규약(로비+인게임, 바이너리 레이아웃)

설계를 바꾸면 **코드뿐 아니라 이 docs도 함께 갱신**한다.

## 레포 구조 (모노레포 · npm workspaces)

| 패키지 | 역할 | 스택 | 상태 |
|---|---|---|---|
| `shared` | 클라·서버 공용 상수/프로토콜/타입 (SSOT) | TypeScript | 비어 있음 |
| `client` | 프론트엔드(메뉴+인게임) | React 19, Vite, Zustand, react-i18next, Phaser(예정) | 타이틀만 |
| `server-match` | 인증·매치메이킹 | NestJS(Fastify), Drizzle, Postgres, Redis, JWT | 인증만 구현 |
| `server-game` | 인게임 서버 | WebSocket(프레임워크 TBD) | 비어 있음 |
| `tools/MapBuilder` | 맵 제작 파이프라인 | Python | 동작함 |
| `legacy/` | 옛 구현(참고용, 워크스페이스 아님) | Express+socket.io | 읽기 전용 |

## 개발 명령어 (루트에서)

```bash
npm run db:up          # docker: Postgres + Redis 기동 (db:down/logs/restart 도 있음)
npm run match:dev      # server-match 개발 서버 (nest --watch)
npm run dev -w client  # client 개발 서버 (vite)
npm run db:push -w server-match   # drizzle 스키마를 DB에 반영
npm run build -w <pkg> # 빌드
npm run lint -w client # 린트
```

- 인프라(Postgres/Redis)는 `docker-compose.yml`. 서버 실행 전 `db:up` 필요.
- 환경변수: 레포 **루트 `.env`** (gitignore됨). 키: `DB_*`, `REDIS_*`, `JWT_*`(ACCESS/REFRESH SECRET·EXPIRATION), `SMTP_*`. docker-compose도 `DB_*`를 참조.

## 핵심 규칙 (harness rules)

1. **`shared`가 단일 진실 공급원(SSOT)이다.** 게임 상수(속도·쿨타임·사거리·틱레이트·타일 physics)와 클라↔게임서버 WS 프로토콜, 공용 타입은 `shared`에만 정의한다. 클라/서버 어디에도 상수를 **중복 정의하거나 하드코딩하지 말 것.**
2. **서버 권위(authoritative).** 인게임에서 클라이언트는 **좌표가 아니라 입력**(이동방향·스킬발동)만 보낸다. 게임 판정·시뮬레이션의 진실은 서버뿐이다. 클라 Phaser는 렌더/입력만.
3. **네트코드 불변식을 지킨다** (레거시 병목 재발 방지, 상세 → `ARCHITECTURE.md` §6):
   - 시뮬레이션 60Hz와 브로드캐스트(20~30Hz)를 **분리**한다. 매 시뮬레이션 틱 브로드캐스트 금지.
   - **맵/자기장은 전송하지 않는다.** 결정론적 타임라인이 맵 에셋에 사전계산돼 있다(→ `MapBuilder`). 게임 시작 시각만 합의.
   - 관심영역/시야 컬링: 볼 수 있는 것만 전송(대역폭 + 안티치트).
   - 방은 **독립 객체로 캡슐화**한다. 프로세스 전역 고정배열 금지(레거시의 확장 불가 원인).
4. **매치 서버와 게임 서버의 책임을 섞지 말 것.** 매치 서버=인증·매칭·핸드오프, 게임 서버=실시간 시뮬레이션. 둘은 Redis(레지스트리·티켓·pub/sub)로 통신.
5. **`legacy/`는 도메인 참고용 읽기 전용.** 룰·감각을 이해하는 데만 쓰고, **구조를 모방하지 말 것**(확장성/효율 문제로 폐기됨). legacy는 npm workspace에 포함하지 않는다.
6. **문서 언어는 한국어**(코드 주석·docs·커밋 메시지). 코드 식별자는 영어.

## 도메인 규칙

- 비밀번호: **8~20자**, 영어·숫자·`!@#$%^&*`만.
- 닉네임: **2~12자**, 영어·숫자·한글만.
- 인원: 최소 3, 최대 8. 스킬 슬롯 2개(도망자=Switch+선택스킬, 술래=선택스킬).
- 타일 physics: 0=바닥, 1=벽, 2=수풀(시야제한·유지), 3=연막(시야제한·자기장에 사라짐). 자기장은 physics 1·3을 제거.

## 환경

- OS: Windows / 셸: PowerShell (POSIX가 필요하면 bash 도구). 경로는 `\` 또는 `/` 상황에 맞게.
- 수치·프레임워크 등 미확정 항목은 docs의 **TBD** 표시 참고. 임의 확정하지 말고 필요 시 확인할 것.
