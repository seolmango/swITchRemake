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

| # | 작업 | 모델 | 범위 | 읽을 문서 |
| --- | --- | --- | --- | --- |
| C | **시뮬레이션과 시야 코어** | **Opus 5** | `server-game/src/simulation/`, `shared/src/visibility/core.ts` | SERVER_ARCHITECTURE 게임 루프 · 벽과 자기장 충돌 · 플레이어 간 충돌과 밀어내기 · 관전, REPLAY 권위 프레임 |
| G | 리플레이 recorder와 로컬 재생 도구 | Sonnet 5 | `server-game/src/replay/` | REPLAY 전체 |
| R | 보안·오류 점검 라운드 | **Opus 5** | 전체 | SERVER_ARCHITECTURE 보안 모델, 아래 "나중에 볼 것" |

C가 Opus인 이유는 문서에 답이 없어서다. 충돌 해결 반복 순서, sub-step 분할, 밀어내기 힘 배분,
술래 접촉 판정은 스펙을 따라가는 게 아니라 물리적으로 맞는지 따져야 한다. 시야 코어는 규칙 자체가
아직 정해지지 않았다. "돌아가긴 하는데 미묘하게 틀린" 코드가 나오기 제일 쉽고 리뷰로 잡기 어렵다.

G는 C가 끝나고 권위 프레임이 실제로 나오기 시작한 뒤에 한다. 경계가 이미 잡혀 있어 대부분 배관이다.

R은 기능이 다 붙은 뒤 한 번에 돈다.

---

## codex가 할 것

순서대로. A 계열과 B/D/E 계열은 서로를 기다리지 않으므로 두 갈래를 동시에 돌려도 된다.

| # | 작업 | 범위 | 읽을 문서 |
| --- | --- | --- | --- |
| 0 | 세션 이전 (**진행 중**) | `server-match/` | SERVER_ARCHITECTURE §3.3 세션 관리, REPLAY 데이터 모델 |
| A1 | 방 API와 배정 명령 발행 | `server-match/` | SERVER_ARCHITECTURE 매칭 서버 책임 · 방 생성 및 참가 흐름 · 매칭 서버와 인게임 서버 사이의 계약 · §3.11 방 참가 남용 방지 · §3.12 한 사용자 한 게임 |
| B1 | map loader, WebSocket 전송, 티켓 인증, 연결 보호 | `server-game/src/{maps,transport,gateway}/` | SERVER_ARCHITECTURE §3.4 접속 티켓 규격 · §3.5 WebSocket 연결 보호 · §3.6 메시지 남용 방지 · MapBuilder 연동 · 권장 코드 구조 |
| D | 방 상태 머신과 대기실 | `server-game/src/rooms/` | SERVER_ARCHITECTURE 방 상태 머신 · 시작 잠금 · 관전 · JSON 메시지 카탈로그 · 연결 해제와 재접속 |
| E | Redis 제어 평면 (인게임 서버 쪽) | `server-game/src/redis/` | SERVER_ARCHITECTURE 인게임 서버 수평 확장 · Redis 사용 규칙 · 매칭 서버와 인게임 서버 사이의 계약 |
| A2 | 경기 결과 저장과 게스트 신원 발급 | `server-match/` | SERVER_ARCHITECTURE 경기 결과 메시지 · §3.12 게스트 접속, REPLAY 데이터 모델 |

**E는 D 뒤에 한다.** D의 `RoomManager`가 있어야 명령을 실제로 처리할 수 있다.

codex 세션을 시작할 때 공통으로 붙일 말:

> `shared/`는 읽기만 하고 고치지 마. 프로토콜 상수, 제어 명령 타입, JSON 이벤트 타입, Redis 키 생성
> 함수(`makeKeys`), consumer group 이름이 전부 거기 있으니 새로 만들지 말고 import 해서 써.
> `server-game/src/simulation/`도 건드리지 마. `server-game/src/config/`는 읽기만 하고, 값을 추가해야
> 하면 먼저 말해줘.

---

## 사용자가 할 것

- F 클라이언트 연결 — 방 API 연동, WebSocket 접속과 티켓 전송, 스냅샷을 엔진에 연결, 대기실 UI
- `config/gameplay.ts`의 밸런스 수치 전부. 지금 값은 구조를 보여주기 위한 임시값이다
- 시작 잠금 5초/10초가 실제로 답답한지, 예측 on/off 중 뭐가 나은지 같은 감각 판정

---

## 순서

```
      [0 세션 이전] ──> [A1 방 API] ─────────────> [A2 결과 저장]
                                                        ▲
      [B1 전송·티켓] ──> [D 방·대기실] ──> [E Redis] ────┘

      [C 시뮬레이션] ──────────────────> D의 PLAYING에 연결 ──> [G 리플레이]

      전부 붙은 뒤 ────────────────────────────────────────> [R 점검]
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
