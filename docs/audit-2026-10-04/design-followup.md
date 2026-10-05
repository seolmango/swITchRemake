# 10월 5일 설계 위험·훈련장 후속 점검

기존 독립 조사 후 요청한 개선이다. 기존 통과 결과를 새 코드의 증거로 대체하지 않는다. 작업 브랜치: `codex/durable-results-room-handoff`.

## 변경과 검증 대상

| 항목 | 사용자 영향·원인 | 수정 | 검증 |
|---|---|---|---|
| 결과 발행 후 프로세스 종료 | 메모리 outbox 또는 Redis 발행 확인만으로는 DB 저장 전 결과가 유실될 수 있음 | 기존 영속 replay 볼륨의 `.result-outbox`에 체크섬·파일/디렉터리 fsync·원자적 게시. DB 커밋과 다음 경기 grant 이후의 receipt까지 보존 | 단위 회귀 및 실제 Redis/PG·두 발행 프로세스 SIGKILL·receipt 손실 재발행. 경기/참가자/XP 중복 방지 비교 |
| 서버 축소 중 대기실 이관 | timeout을 실패로 확정하거나 방/사용자 소유권을 따로 갱신하면 양쪽 서버가 같은 방을 소유할 수 있음 | 출발 방 동결, 도착 방 비공개 staging, 단일 Redis Lua로 intent·directory·모든 actor claim 비교/전환. 취소와 commit을 같은 fence로 경합 | 실제 Redis 20회 경합·충돌 시 전부 불변·중복 거부, 실제 worker 1→2→1 및 이관 전후 경기/PG |
| 훈련장 모든 번호 거부 안내 | 술래가 없는 상태도 `NO_TARGET`, 기본 사냥 모드에서 자신이 술래일 때 `NO_SKILL` 반환 | `NO_TAGGER`와 `ROLE`로 조건을 구분. 훈련 화면에서 도망 모드 선택 후 아래 구역 진입 안내 | 실제 맵의 번호 1..8 판정, 실제 브라우저 이동·패드·번호키·서버 `player.tagged` 검증 |

훈련장의 스위치는 도망자만 사용할 수 있고, 현재 술래가 가까이 있어야 한다. 자기 번호와 현재 술래 번호는 대상이 아니다. 실제 맵에서 사용자1·술래6 조건이면 2/3/4/5/7/8은 성공하고 1/6은 거절된다. 기본 사냥 모드의 거부는 게임 규칙이며 이를 없애지 않았다. `NO_TARGET`와 `OUT_OF_RANGE`는 다른 스킬도 사용하므로 일반 안내를 유지했다.

## 실행 상태

- 호스트 집중 회귀: 훈련26·스킬33·클라이언트 유틸22 통과. 결과 worker7 통과. 방 이관/결과 journal을 포함한 server-game 전체 단위 통과.
- 격리 실제 스택 `durable-oct05`: 정적·타입·lint·단위 및 새 내구성/원자성 gate 통과. 첫 core 브라우저9/10 통과, 훈련장 모드 선택 실패. 집중 재실행에서 짧은 입력 누락·늦은 정지와 패드 재진입을 관측했다. 이 최초 실행을 core 전체 성공으로 세지 않는다.
- 훈련장 후속 브라우저 성공: Canvas fallback에서 18.0초. 실제 방향/중립 패킷·권위 좌표·패드 정확히1회 진입·ROLE/NO_TAGGER 화면·번호키 성공 `player.tagged`·정상 퇴장을 확인했다. 함께 실행된 임시5초 CPU 진단은 기능 검사의 통과 건수에 포함하지 않는다.
- 별도 scaling 실제 통과: 두 worker·방 이관·이관 전후 경기/PG 저장(3.3분), Linux 실제 프로세스1→2→1 확인. 증거: `e2e/artifacts/audit/durable-oct05-scaling-passed/scaling-processes.json` 및 해당 실행의 summary.
- 새 core는 기존 10 gate에 결과 내구성과 실제 Redis 원자성 2 gate를 추가한다. 훈련장 성공 경로도 push/PR 브라우저 검사에 포함한다.
- Azure에는 이 문서 작성 시점까지 후속 변경을 배포하지 않았다.

## 재현·운영 제한

`deploy/audit/README.md`의 동일 실행 명령을 사용한다. `AUDIT_RUN_ID`를 새 값으로 지정하고 `node scripts/audit-stack.cjs run core`; 동적 증감은 유지한 격리 스택에서 `node scripts/audit-stack.cjs scaling extended`로 확인한다. CI는 Azure·운영 비밀 없이 실행한다. 내구성 probe는 내부 DB/Redis 및 합성 데이터만 허용하고 65초, 원자성 probe는 15초와 20회 경합으로 제한한다. 강제 종료 대상은 probe가 만든 자식 프로세스뿐이다.

DB 마이그레이션은 없다. 결과 journal은 기존 `REPLAY_LOCAL_DIR`의 영속 볼륨을 반드시 유지해야 한다. 새 코드의 혼합 버전 이관을 보장하지 않으므로 배포 시 비어 있는 상태를 확인하고 match/cluster를 함께 교체한다. 이전 이미지와 원복 스크립트를 보존한다.

## 남는 한계

- journal 기록 전의 디스크 쓰기 실패와 프로세스 손실이 동시에 발생하거나 볼륨 자체가 사라지면 결과 복구를 보장하지 않는다. 디스크 오류 시 새 경기 시작을 막고 메모리 재시도를 유지한다.
- 각 결과 파일은 256KiB 상한, 한 flush는 최대128개다. 공유 Redis lease로 중복 발행 속도를 제한한다. 이미 진행 중인 경기 결과는 admission 상한을 넘더라도 버리지 않는다.
- DB receipt는 7일 유지한다. 장기 중단 후 재발행은 DB 멱등성에 의존한다. 저널 파일 손상은 시작/신규 경기 허용을 차단한다. Linux의 파일·디렉터리 fsync 기준이며 Windows 전원 장애 내구성을 같은 수준으로 주장하지 않는다.
- 프로세스 자체가 사라진 대기실의 roster 재구성은 별개 과제다. Redis 응답이 불명확하면 원본을 동결하여 이중 소유를 방지하며, 24시간 intent TTL을 넘는 장기 장애의 자동 복구는 보장하지 않는다.
- 제한된 Docker/Chromium 소프트웨어 WebGL 훈련에서 입력 송신 약4Hz·정지 지연0.3~1.13초를 관측했다. 5초 CPU 샘플 대부분이 native/program이었다. 훈련 스위치 CI는 제품이 지원하는 Phaser.AUTO의 Canvas fallback과640×480, 정상 UI의30fps/낮음/75%를 사용한다. 기존 WebGL 다인원 경기·훈련 UI는 유지한다. 이 결과로 WebGL의 훈련 정밀 조작이나 실제 GPU/휴대폰 성능을 보장하지 않는다. 정적 맵 Graphics 캐시는 추가 GPU 메모리·화질 검증이 필요해 이번에 넣지 않았다.
- 이 검사는 실제 디스크 고갈·전원 손실·장기 장애·Azure 부하/장애 주입을 수행했다는 뜻이 아니다.
