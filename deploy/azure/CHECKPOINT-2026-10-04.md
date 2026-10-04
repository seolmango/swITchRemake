# Azure 진단 작업 중간 기록 (2026-10-04)

이 문서는 식사 전 중단 시점의 기록이다. 재개 후 결과는 [검증 기록](VERIFICATION-2026-10-04.md)을 참조한다.

사용자 요청으로 식사 시간 동안 일시 중단한다. 완료 보고서가 아니다. 기존 계정과 경기 데이터는 삭제하지 않았다. 모든 브라우저 검증은 무음으로 진행했다.

## 저장 및 배포 상태

- GitHub main에 `f02af85`, `977016d`, `010d33b`까지 push했다. 초기 미커밋 Azure 배포/TLS 설정도 보존하여 커밋했다.
- 후속 모바일 메뉴 및 풀 경계 무한 반복 수정은 작업 트리에 보존되어 있으며 아직 커밋하지 않았다.
- 실행 backend: `sha256:dd5050fd4bede8646ee22ce869b57f01d9d5d1e230e7806988a30d99bcca1dfb`, buildId `azure-fix-010d33b`.
- 실행 web: `sha256:7f026ddf43b43fa406636567b2ff96542a80d72d392e1570e8d0ffffba87ee78`, tag `switch-azure-web:outline-fix-20261004`를 `:local`로 배포했다.
- VM `/opt/switch-dev/rollback-20261004/`에 기존 설정 보관, backend/web `:rollback-20261004` 태그 보존. 재시작 전 로그는 VM의 보호된 `diagnostics/`에 보관했다.
- 리소스 추가/사양 변경/DB 초기화/관리자 비밀번호 변경은 하지 않았다.

## 확인된 원인과 수정

- 60Hz 게임/30Hz 송신 타이밍 때문에 첫 snapshot이 tick 2이면 MAP/ROSTER를 보내지 않던 문제: 최초 수신자를 명시적으로 full snapshot 대상으로 등록.
- 다음 경기 입력 번호 초기화 누락, 경기 중 명시적 퇴장 거부, 술래 퇴장 직후 술래 부재: 서버 수정 및 회귀 테스트.
- 서로 다른 HTTP 경로가 같은 요청 카운터를 공유해 정상 사용 중 인증 갱신을 429로 차단: 경로별 제한과 전체 상한 분리.
- 갱신 후 요청 실패/일시적 서버 오류를 로그아웃으로 처리: 세션 보존 및 재시도 화면. 비밀번호 변경은 현재 세션 토큰을 재발급하도록 수정했으나 실제 관리자 비밀번호는 변경하지 않음.
- 관리자 감사 로그 날짜 변환 500, 결과 저장 후 다음 경기 발급 실패를 ACK하던 문제: 날짜 정규화, 재시도 가능한 멱등 처리.
- 초기 snapshot 버퍼, 모바일 입력 표기/화면 높이, 목록 갱신, 생존자 스위치 단축키 표기 및 메뉴 배치 수정.
- **BattleField 약 75초 브라우저 정지**: 실제 두 renderer의 CDP stack이 `redrawGrass` 내부 윤곽선 추적에 정지. 대각선 타일 접점에서 outgoing edge를 덮어쓴 뒤 다른 cycle을 무한 순회했다. 다중 edge 보존/edge별 소비로 수정. 512가지 3×3 타일 배치의 면적·경계 길이를 검사하는 회귀 포함.

## 이미 통과한 검증

- 전체 workspace 테스트 및 타입 검사 통과(선택적 DB 통합 테스트 1개 skip). 이후 최종 client 변경은 258개 테스트/빌드/린트 통과.
- 4개 독립 인증 WebSocket: 2경기, 술래 퇴장 즉시 교체, 방장 이전, 맵/스킬 선택, 관전 재접속, 스킬/스위치, 자연 종료, 결과 저장, 방 정리.
- 정원 제한, 1인 훈련장, 훈련장 포함 총 방 2개 제한.
- 실제 Chromium 3개 독립 context에서 TestMap1 두 경기: 전원 시작/이동/결과/대기실 복귀 통과.
- 해당 경기 `1f66d2db-8dba-46ff-bcf0-ac4504ecca49`, `2a48112f-9a72-4597-90cb-1a72552fa242` DB 결과 3명 및 리플레이 저장 확인. DB TLS 인증서 검증 유지.
- IAB 일반 회원 로그인 유지, 관리자 현황/감사 로그, 회원 전적, 훈련장 진입/종료 확인.
- 39개 desktop/portrait/landscape 화면 검사에서 추가 홈 버튼 겹침/가입 제목 가림/로그인 버튼 테두리 겹침을 발견하여 후속 수정. 이 최종 화면 수정의 screenshot 재검증은 남아 있다.

## 증거 위치

Git에서 제외되는 로컬 `e2e/artifacts/azure-20261004/`:

- `before-ws.json`: 배포 전 첫 snapshot 결함
- `after-four-player-complete.json`, `after-lobby-training-complete.json`: 통과한 다인원/방 제한 검사
- `browser-evidence-1791104279964.json`: TestMap1 실제 브라우저 2경기 통과
- `browser-evidence-1791104889421.json`: BattleField 정지 renderer의 실제 CDP stack
- `outline-old-hang.json`: 기존 함수 최소 입력 무한 반복 재현
- `final-tests.txt`, `final-typecheck.txt`, `layout/`, `round-*-game.png`, `round-*-result.png`
- `test-replay.swrp`: 이 검증에서 생성한 게스트 경기 파일. SSH로 복사했으며 HTTP 다운로드 권한 검증 증거로 세지 않는다.

## 재개 시 남은 작업

1. 새 web의 BattleField 실제 3인 2경기는 중단 직전 **통과**했다(4.1분). 전원 결과 및 다음 경기/대기실 복귀 확인, 검증용 browser context 종료. 경기 ID `39310d12-2486-416c-abe4-e90a9695549f`, `f006c6b8-f2fa-46be-947a-7b6e8ff31399`. 이 두 경기의 DB 저장 최종 대조는 재개 시 진행한다.
2. 최종 39개 화면/모바일 터치·로비·결과 화면 재검증. how-to/admin portrait 가독성과 replay 화면 높이 후보를 실제 화면으로 확인 후 필요 시 수정.
3. 리플레이 파일 열기/서명/재생 확인. IAB 회원 다운로드 클릭은 도구 download event timeout으로 완료 판정하지 않음.
4. 최종 실제 이미지/컨테이너/Redis 명령 및 결과 처리/DB 저장 증거를 정리한다.
5. 후속 변경과 테스트 스크립트 커밋/push, 검증 범위와 남은 한계를 최종 보고한다.

회원가입 메일/MFA, 실제 비밀번호 변경, 물리적 휴대폰 및 네트워크 단절의 모든 종류는 아직 end-to-end 검증하지 않았다. 모든 버그가 없다는 의미가 아니다.
