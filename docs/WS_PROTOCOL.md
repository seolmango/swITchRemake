# swITch WebSocket 프로토콜 (server-game)

게임 서버와 클라이언트 간 실시간 통신 규약. 로비(대기실)와 인게임을 **하나의 WS 연결**로 처리한다. 계정/매치메이킹은 `API_SPEC.md`, 설계 배경은 `ARCHITECTURE.md`.

메시지 타입·상수·레이아웃은 **`shared` 패키지에 단일 정의**하고 클라/서버가 공유한다.

## 인코딩 원칙

- **핫패스(input·snapshot)는 바이트 정렬 바이너리**(`ArrayBuffer`/`DataView`). 서브바이트 비트패킹은 하지 않는다(복잡도↔이득 불균형). 필요 시 나중에 조각.
- **로비·이벤트 등 저빈도 메시지는 JSON**(`{ type, ... }`)으로 시작해도 무방(가독성·개발속도). 트래픽이 문제되면 바이너리로 승격.
- 바이너리 프레임 첫 바이트 = **`type`(uint8)**. 멀티바이트 정수는 **little-endian**, 좌표는 `uint16`(px, 0~65535 — 최대맵 50타일=12800px 수용).
- **저빈도 이벤트는 스냅샷에 넣지 않고 별도 메시지**로 보낸다(이모지·스킬·아웃·술래변경 등). 스냅샷은 위치 위주로 슬림하게.
- WebSocket은 TCP(순서보장·재전송) — UDP식 패킷 드랍 가정 금지.
- **트래픽 절감**: 스냅샷은 **시야(AoI) 필터링**으로 볼 수 있는 유저만 포함(가변 길이). 맵/자기장/쿨타임은 **미전송**(결정론적, 클라가 맵 에셋으로 계산).
- **스냅샷 부재 의미론**: 스냅샷에 없는 유저 = "안 보임"이지 "떠남"이 아니다(이탈은 별도 이벤트). 시야 재진입 시 보간 히스토리가 없어 팝인이 생기므로 클라가 페이드인 등으로 처리한다.
- **슬롯 번호**: 와이어(패킷)는 **0~7**, UI 표시는 **1~8**(+1). 혼용 금지.
- **서버 tick은 u16으로 랩(wrap)** 된다(60Hz 기준 ≈18분 주기). 클라는 랩어라운드를 처리한다. 시간 동기는 벽시계가 아니라 **서버 틱 기준**으로 한다.
- **넷코드 = 보간(interpolation)만** (MVP): 서버 권위 + 클라가 스냅샷 사이 보간. 클라 예측 없음 → 입력에 시퀀스 번호 불필요.

## 연결 (핸드셰이크)

WS 최초 프레임으로 접속 의도를 보낸다(JSON).

- **최초 입장**: `{ mode: "join", ticket, accessToken?, guestNickname? }`
  - 게임서버: `ticket:{ticket}` 1회 소비·검증(자기 서버·roomId 확인) → 로그인이면 accessToken JWT 검증(userId), 게스트면 guestNickname 사용 → 방 없으면 지연 생성 → 입장.
- **재접속**(로그인 유저 한정): `{ mode: "reconnect", roomId, accessToken }`
  - JWT userId로 해당 방의 `RECONNECTING` 슬롯을 찾아 재개(매치 티켓 불필요). **슬롯이 `RECONNECTING` 상태일 때만 수락** — 원 연결이 살아있으면 거절(탈취된 토큰으로 진행 중 세션을 가로채는 것 방지). 게스트는 재접속 불가.
  - 최초 입장 시에는 **JWT `sub` == 티켓 `userId` 대조** 필수(티켓 유출 대비, → `ARCHITECTURE.md` §4).
- 실패 시 close code로 사유 전달(무효 티켓/정원초과/방없음/재접속불가 등).

---

## 로비 (대기실)

### C→S
| 메시지 | 페이로드 | 권한 |
|---|---|---|
| `selectLoadout` | `{ skill }` (dash/flash/exhaust) | 본인 |
| `changeSlot` | `{ slot }` (0~7 중 빈 슬롯) | 본인, 충돌 시 실패 응답 |
| `changeMap` | `{ mapId }` | 방장 |
| `kick` | `{ targetSlot }` | 방장 |
| `passOwner` | `{ targetSlot }` | 방장 |
| `startGame` | `{}` | 방장(최소 3명). **준비(ready) 개념 없음** — 카운트다운이 오시작을 방지 |
| `spectate` | `{}` | IN_GAME/STARTING 방 입장자(관전 시작) |
| `leave` | `{}` | 본인 |

### S→C
| 메시지 | 페이로드 |
|---|---|
| `roomState` | 입장 시 전체: `{ roomId, roomCode, name, mapId, ownerSlot, state, players: [{ slot, nickname, isGuest, level, winRate, skill }] }` |
| `playerJoined` | `{ slot, nickname, isGuest, level, winRate }` |
| `playerLeft` | `{ slot }` |
| `slotChanged` | `{ fromSlot, toSlot }` |
| `ownerChanged` | `{ ownerSlot }` |
| `mapChanged` | `{ mapId }` |
| `loadoutChanged` | `{ slot, skill }` |
| `kicked` | `{}` (당사자에게) |
| `gameStarting` | `{ countdown }` — **카운트다운 시작 = 게임 시작 판정**(이후 입장자는 다음 판) |
| `gameCanceled` | `{}` — 카운트다운 중 이탈로 3명 미만 시 취소, WAITING 복귀 |
| `gameStarted` | `{ mapId, mapVersion, startTick, initialPlayers: [{ slot, x, y, skill }], taggerSlot }` — `mapVersion`(해시) 불일치 시 클라는 맵 에셋 재로드(조용한 디싱크 방지). 자기장 타임라인은 `startTick` 기준 재생 |

- `isGuest`는 클라가 게스트 닉네임을 **다른 색으로 렌더**하는 데 사용(로그인 유저와 구분).
- 게임 종료 후 같은 방으로 복귀 → 서버가 `roomState`(WAITING)로 갱신.
- 시작 방식 = **방장 수동 시작**(자동 시작·준비 개념 없음).
- **방장 이탈/끊김 시 자동 위임**: 서버가 남은 인원 중 가장 낮은 슬롯에게 위임 후 `ownerChanged` 브로드캐스트(수동 `passOwner`와 별개).

---

## 인게임

### C→S — 입력
클라는 **좌표가 아니라 입력만** 보낸다. 입력 변화 시 또는 제한된 입력틱으로 전송(매 프레임 무조건 X). 보간만 쓰므로 시퀀스 번호 없음.

**`input` 패킷 (4 bytes)**
| offset | 크기 | 필드 |
|---|---|---|
| 0 | u8 | `type` = INPUT |
| 1 | u8 | 이동 비트마스크 (bit0 상, 1 하, 2 좌, 3 우) |
| 2 | u8 | 이동기 발동 (bit0 = 선택스킬 사용) |
| 3 | u8 | switch 대상 슬롯(0~7); **자기 슬롯이면 미사용** |

- 이모지는 별도: **`emoji` `{ id }`** (저빈도).
- switch는 도망자만 유효, 술래 근접(≤240px) 조건은 서버가 판정.

### S→C — 스냅샷 (20~30Hz)
**`snapshot` 패킷** — 헤더 + 가변 길이 유저 배열(시야 필터링됨)

헤더 (4 bytes)
| offset | 크기 | 필드 |
|---|---|---|
| 0 | u8 | `type` = SNAPSHOT |
| 1 | u16 | 서버 tick (0~65535 wrap) |
| 3 | u8 | 현재 술래 슬롯(0~7) |

유저 엔트리 (7 bytes × N)
| offset | 크기 | 필드 |
|---|---|---|
| +0 | u8 | 슬롯(0~7) |
| +1 | u16 | x (px) |
| +3 | u16 | y (px) |
| +5 | u16 | 상태 비트필드 |

상태 비트필드(u16): bit0 유체화중 · bit1 탈진걸림 · bit2 점멸직후 · bit3 광란중 · bit4 접속끊김(RECONNECTING) · bit5 아웃(관전) · 나머지 예약.

> 8인 스냅샷 ≈ 4 + 8×7 = 60바이트. 30Hz면 ≈1.8KB/s/클라 — 시야 필터로 더 줄어듦.

### S→C — 이벤트 (비결정론적, 발생 시)
| 메시지 | 페이로드 |
|---|---|
| `skillUsed` | `{ slot, skill, targetSlot? }` (이펙트 렌더용) |
| `eliminated` | `{ slot, bySlot, order }` |
| `taggerChanged` | `{ slot, reason }` (switch/forced/disconnect) |
| `emoji` | `{ slot, id }` |
| `playerDisconnected` | `{ slot }` (10초 정지 시작) |
| `playerReconnected` | `{ slot }` |
| `gameOver` | `{ winners: [slot], stats: [{ slot, kill, swTry, swSu, deathOrder }] }` |

- 자기장/타일 변화·쿨타임은 이벤트로 안 보냄(클라가 `startTick` + 맵 타임라인으로 계산).

---

## 상태·엣지 케이스

- **아웃 → 자동 관전**: `eliminated` 후 해당 클라는 관전 모드로 전환. 정원(8) 내 유지.
- **관전 2모드**: ① **플레이어 시점** — 특정 생존자를 선택해 그 사람의 시야로 봄, ② **자유 카메라** — 맵을 자유롭게 이동. 두 모드는 **클라에서 자유 전환**(서버 왕복 불필요). 구현: 서버는 관전자에게 **시야 컬링 없는 전체 스냅샷**을 보내고, 플레이어 시점 모드의 시야 제한은 클라가 렌더 단계에서 적용. 고스팅은 감수(판당 ~5분의 짧고 스피디한 게임).
- **게임 중 입장**: `roomState`(IN_GAME/STARTING) 수신 + `spectate`로 진행 게임 관전. 다음 판 참가(슬롯 보유). 정원 밖 순수 관전자는 MVP 제외.
- **중도 이탈(탈주)**: 그 시점 아웃 처리 — `eliminated`(bySlot 없음) + `death_order` 부여, 스탯 반영. 로그인 유저의 비정상 끊김만 아래 10초 유예 적용.
- **재접속(로그인 유저)**: 끊기면 `playerDisconnected` 브로드캐스트, 캐릭터 10초 제자리 정지(**여전히 충돌·아웃 대상** — 끊김이 안전을 주지 않음). 10초 내 `reconnect` 성공 → `playerReconnected` 재개. 초과 → `eliminated`. 끊긴 유저가 술래면 **즉시 강제 술래 교체**(게임 정지 방지), 복귀 시 도망자.
- **게스트**: 재접속 불가(끊기면 `playerLeft`).
- **정원**: 최종 권위는 게임서버. Redis playerCount는 힌트, 초과 접속은 거절.

## 서버측 검증 (필수)

"서버 권위" 원칙이 실효를 가지려면 게임서버는 모든 C→S 메시지를 다음과 같이 방어한다:

- **레이트리밋**: 입력 패킷 수신 상한(예: 초당 60개 초과분 드랍, 지속 남용 시 연결 종료). 로비 메시지에도 상한 적용. 클라의 "변화 시에만 전송"은 예의일 뿐, 강제는 서버 몫이다.
- **형식 검증**: 바이너리 길이·필드 범위(슬롯 0~7 등) 검사, 불일치 시 무시. 최대 메시지 크기 제한.
- **권한·상태 검증**: 스킬 쿨타임·역할 조건(switch=도망자만)·거리 조건·방장 권한·생존 여부는 전부 서버가 판정한다. 클라가 보낸 값은 "요청"일 뿐이다.

## 메시지 타입 상수 (초안, `shared`에 정의)

```
// 바이너리 핫패스
INPUT = 0x01
SNAPSHOT = 0x02
// 그 외(로비·이벤트)는 JSON { type: "roomState" | "eliminated" | ... }
```

> 원칙: **핫패스(input·snapshot)만 바이너리**, 로비·이벤트 등 저빈도는 JSON. 트래픽이 문제되면 바이너리로 승격.
