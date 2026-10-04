# Azure 게임 오류 수정 및 검증 기록 — 2026-10-04

대상은 기존 개발 VM과 실제 HTTPS 주소다. 모든 테스트는 무음으로 실행했고, 기존 계정·경기 데이터를 삭제하지 않았다. 테스트 게스트/방에는 `az-`, `검증` 이름을 사용했다. 새 유료 리소스나 VM 사양 변경은 없다.

## 재현한 원인과 수정

| 증상 | 확인한 원인 | 수정 및 회귀 |
| --- | --- | --- |
| 캐릭터·맵 누락, 시작 후 진행 불가 | 60Hz 시뮬레이션/30Hz 송신의 위상에 따라 첫 전송이 tick 2가 되면 초기 MAP/ROSTER가 누락 | 최초 수신자별 full snapshot, lazy renderer 초기 데이터 병합. 실제 배포 전 tick 2 실패와 회귀 테스트 |
| 큰 맵 약 75초에서 화면 정지 | 대각선으로 닿는 풀 타일의 경계선이 덮어써져 닫히지 않는 무한 순회 | 실제 멈춘 두 브라우저 CDP stack의 `redrawGrass` 경로와 최소 2타일 입력으로 확인. edge별 추적, 512가지 타일 배치의 면적·경계 회귀 |
| 다음 경기에서 입력 무시 | 서버의 직전 경기 입력 순번 유지 | 경기 전환 시 순번 초기화 |
| 나가기 실패·술래 없는 구간 | 진행 중 명시적 퇴장 거부, 술래 퇴장 시 즉시 대체 없음 | 퇴장/탈락 처리, 방장 이전, 남은 플레이어에서 즉시 술래 교체 |
| 정상 사용 중 인증 실패·강제 로그아웃 | 다른 HTTP 경로가 같은 카운터를 사용하여 일반 요청이 인증 갱신 제한을 소진. 갱신 뒤 일반 요청 오류·일시적 bootstrap 실패를 로그아웃으로 처리 | 경로별 제한과 전체 상한 분리. 실제 인증 거부와 일시적 오류 구분, 세션 유지/재시도 |
| 비밀번호 변경 뒤 세션 무효 | token epoch 변경 후 현재 세션의 token 미갱신 | 현재 세션 token 재발급, 다른 세션 폐기. 관리자 실제 비밀번호는 변경하지 않음 |
| 관리자 감사 로그 500 | 문자열 날짜에 Date 메서드 호출 | Date/string 정규화 |
| 결과는 저장됐지만 다음 경기 진행 위험 | 다음 경기 grant 발급 실패를 삼킨 후 결과 stream ACK | source row 잠금과 결정적 ID를 사용한 멱등 재시도, 실패 시 ACK 보류 |
| 모바일 하단 여백·키보드 표기·겹침 | 고정 stage/viewport 높이, 기기와 무관한 키 표시, 중복 조작 버튼 | visualViewport/dvh, 터치 표기와 조작 영역 정리, 메뉴의 실제 화면 폭 배치 |
| 생존자 옆 파란 숫자 의미 불명 | 스위치 키 번호만 노출 | 스위치 동작임을 명시 |
| 방 목록에 퇴장한 방 잔류 | 목록의 주기적/복귀 갱신 없음 | 주기·포커스·표시 상태 갱신 |
| 코드로 비공개 방 참가 불가 | URL에 `pw=true`가 없으면 비밀번호 필드가 계속 disabled | 수동 코드에도 선택적 비밀번호 입력, 기존 서버 비밀번호/권한 검사는 유지 |
| 리플레이 작거나 비어 보임·시간 2배 | stage 높이 누락, 늦게 준비된 renderer가 map effect를 실행하지 않음, 60Hz tick을 30Hz로 나눔 | 화면 영역 확보, 엔진 준비 의존성, 검증된 map bundle의 simulationHz 사용, 카메라와 관전 명단 초기화 |

## 실제 검증 범위

| 흐름 | 결과/근거 |
| --- | --- |
| 게스트·회원 로그인 | 독립 guest 인증 context/WS 사용, 정상 회원 로그인 및 1시간 이상 지난 기존 세션 유지 확인 |
| 방 생성·코드 참가·맵·스킬 | 실제 4인 WS 및 브라우저 검사. 비공개 수동 코드 참가 오류를 별도 재현 후 수정 |
| 시작·카운트다운·초기 진입·이동 | 실제 Chromium 독립 context 3개, 각각 고유 guest와 연결. 첫 full MAP/ROSTER와 서버 좌표 변화 검사 |
| 큰 맵 종료·다음 경기 | BattleField 두 경기 전원 결과/대기실 복귀 통과. 각 경기 약 103초로 기존 75초 정지 지점 통과 |
| 스킬·스위치·술래·탈락·승리 | 실제 4인 연결의 합법 입력과 서버 이벤트, 자연 종료/공동 승리 확인 |
| 술래·방장 이탈 | 4인 진행 중 즉시 술래 교체, 대기실 방장 이전 확인 |
| 끊김·재접속 | 진행 중 끊김 후 정상 resume ticket을 통한 관전 full snapshot, 대기실 새로고침 후 같은 identity/인원 유지 |
| 결과 저장 | DB read-only 확인: 참가자 3명, 공동 우승자 2명, 리플레이 available, TLS 인증서 검증 유지 |
| 회원/게스트 혼합 | 회원 브라우저 1개 + 독립 게스트 2개로 종료·회원 XP/전적 반영·대기실·퇴장 확인 |
| 훈련장·방 제한 | 실제 1인 훈련장, 정원 초과 거부, 훈련장을 포함한 2방 제한, touch 이동의 서버 좌표 변화 확인 |
| 관리자 | desktop 현황·감사 로그 정상 조회. 최신 portrait 배치의 실제 관리자 검사는 아래 제한 참조 |
| 리플레이 | 자체 테스트 경기 파일의 서명 확인, map 렌더링·재생 진행 검증. 파일은 SSH로 취득했으므로 회원 HTTP 다운로드 성공 증거로 세지 않음 |
| 레이아웃 | desktop 1440×900, portrait 390×844, landscape 844×390. 설정 세부 탭·도움말·리플레이를 포함한 45개 화면에서 버튼 겹침·가로 넘침 검사 통과 및 이미지 확인 |

일반 경기에는 별도의 준비 체크 버튼이 없고 방장 시작 및 변경 후 잠금 시간으로 제어한다. 퇴장 후 재입장에는 기존 60초 대기 규칙을 그대로 지켰다. 진행 중 연결 끊김은 기존 규칙에 따라 탈락하고 관전자로 재접속한다.

## 결과와 실행 상태 증거

- 최종 Web 배포 후 BattleField 실제 브라우저 연속 경기: `3b2a5cbe-fdc2-487e-80a9-a31f00317553`, `3676afbc-65f4-45d1-972f-42de9c07704a`. 독립 3명 모두 두 번의 결과 화면과 대기실 복귀, 이동·첫 full snapshot 검사 통과 (`final-browser-long.txt`, 4.1분).
- 최종 공개 UI 검사 4개 통과: 45개 화면 배치, 비공개 방/재접속/방장 이전, 리플레이, 터치 훈련장 (`final-browser-flows.txt`).
- 두 경기 DB `stored`, 참가자 3, 우승자 2, replay available 확인. `final-long-match-db.json`.
- TestMap1 브라우저 연속 경기: `1f66d2db-8dba-46ff-bcf0-ac4504ecca49`, `2a48112f-9a72-4597-90cb-1a72552fa242`.
- 회원/게스트 혼합 경기: `a47cff47-72a2-413b-a431-7677d00d8c1f`.
- 확인 시 match/cluster/web restart count 0, OOM false. VM의 작은 메모리를 최초 원인으로 단정하지 않았고 위 원인은 코드와 실제 재현으로 확인했다.
- 검증 종료 후 Redis room 키 목록 공백, 명령/result consumer pending/lag 0. 방 목록 첫 페이지만으로 방 삭제를 판정하지 않았다.

로컬 증거는 Git 제외 경로 `e2e/artifacts/azure-20261004/`에 있다. 전체 로그의 민감한 원본은 VM 보호 디렉터리에 남겨 공개하지 않았다.

- `before-ws.json`, `outline-old-hang.json`, `browser-evidence-1791104889421.json`: 수정 전 원인 증거
- `after-four-player-complete.json`, `after-lobby-training-complete.json`, `member-mixed.json`: 실제 다인원/방 흐름
- `round-*-game.png`, `round-*-result.png`, `replay-loaded.png`, `mobile-touch-training.png`, `layout/`: 화면
- `final-tests.txt`, `final-client-tests.txt`, `final-typecheck.txt`, `final-client-lint.txt`: 로컬 검증
- `final-long-match-db.json`, `runtime-after.txt`, `redis-after.json`: 실행/저장 상태

## 재실행

로컬 전체 단위 테스트/타입 검사와 클라이언트 lint/build를 실행했다. 최신 client 265개 포함 총 815개 통과, DB 통합 테스트 1개는 별도 테스트 DB 미설정으로 skip했다. 이 skip을 실제 Azure DB 저장 검증으로 위장하지 않았다.

```powershell
npm test
npm run typecheck
npm run lint -w client
npx playwright test -c e2e/azure.config.ts
# 75초를 넘기는 큰 맵 회귀
$env:E2E_LONG_MATCH='1'
npx playwright test -c e2e/azure.config.ts multiplayer.spec.ts
node scripts/azure-room-flows-check.cjs --output e2e/artifacts/four-player.json
node scripts/azure-room-flows-check.cjs --lobby --output e2e/artifacts/capacity.json
```

라이브 테스트는 개발 서버에 실제 임시 게스트/방/경기 기록을 생성한다. 테스트 context와 자신이 만든 연결만 닫고 계정/DB 데이터를 삭제하지 않는다. 방 제한이 2이므로 여러 검증을 동시에 실행하지 않는다. 리플레이 테스트는 자체 생성한 `.swrp`를 `E2E_REPLAY_FILE`로 지정한다. 일반 E2E의 계정 삭제 teardown을 호출하지 않는다.

## 배포와 되돌리기

수정된 이미지를 로컬 Dockerfile로 빌드 → SSH 전송 → VM docker load → 실제 컨테이너 재생성 후 image ID로 확인했다. 웹의 후속 배포 때에는 match/cluster를 재시작하지 않았다.

- Backend 실행 이미지: `sha256:dd5050fd4bede8646ee22ce869b57f01d9d5d1e230e7806988a30d99bcca1dfb` (`azure-fix-010d33b`).
- 최종 Web 실행 이미지: `sha256:e2a0790cd24424d1dc3f7065cd59c04b5d774cc535fe9b5b93d6f06c12ad0baf` (`switch-azure-web:final-20261004`).

기존 backend/web은 `:rollback-20261004`로 보존했고 기존 설정은 VM `/opt/switch-dev/rollback-20261004/`에 접근 제한하여 보관했다. 원복하려면 기존 VM에서 해당 태그를 `:local`에 다시 붙인 뒤 필요한 서비스만 재생성한다. 볼륨 삭제나 DB 초기화는 필요 없다.

## 남은 한계

- 실제 휴대폰 기기의 브라우저 주소창·키보드·운영체제별 동작은 전부 확인하지 않았다. 모바일 검증은 Chromium touch/viewport 모사다.
- 이메일 발송을 포함한 가입·비밀번호 재설정·MFA 전체, 관리자 실제 비밀번호 변경은 미실행이다.
- 회원 리플레이 다운로드 클릭은 IAB download 이벤트가 timeout되어 완료 판정하지 않았다. 파일 서명/재생은 별도로 검증했다.
- 최신 관리자 portrait 실제 화면 검사는 자동 승인 검토의 사용량 한도 오류로 차단됐다. 다른 브라우저로 우회하지 않았다. desktop 감사 로그/현황 검증과 코드/빌드 검사까지 확인했다.
- 모든 물리적 네트워크 장애, 장시간 부하, 모든 모바일 해상도·접근성 조합을 검증한 것은 아니다. 모든 버그가 없다고 단정하지 않는다.
