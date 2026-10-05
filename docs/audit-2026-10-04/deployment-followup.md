# 수동 배포 결과 및 원복 준비

2026-10-05 소유자가 병합과 SSH 이미지 교체 배포를 명시적으로 승인했다. 검사한 코드 `5c87efd88ecf664581b36e8422538cde8048d7fd`를 main에 fast-forward 병합하고 backend/web 이미지 및 Caddy 보안 헤더를 배포했다. 친구 사용자 데이터·세션·암호·기존 인증 키는 변경하지 않았다. 다음 항목은 실행 절차와 남은 운영 확인 범위를 함께 기록한다.

## 검증한 변경의 배포 조건

최종 core Actions가 통과한 commit SHA와 extended/local 결과를 선택하고, 같은 소스로 backend/web 이미지를 로컬에서 빌드했다. `Dockerfile.backend`, `deploy/Dockerfile.web`은 audit과 같은 Node digest/npm11.21.0을 사용하도록 고정했다. 릴리스 이미지 내 Fastify5.12.5를 확인했으며 lockfile 기반 npm ci를 사용했다. 자동 Actions 배포는 없다.

이번 변경에 스키마 migration 추가는 없다. 기존 DB/Redis/JWT/암호화/리플레이 서명 키를 그대로 사용한다. SMTP 옵션을 추가했지만 운영 미지정 시 기존 Gmail 기본값을 유지한다. 관리자 암호 변경은 소유자만 수행한다.

## 승인받아 실행한 절차

1. 소유자의 즉시 배포 승인 후 실제 방/경기/연결 수를 읽기 전용으로 확인하고 모두0일 때만 진행했다.
2. `/opt/switch-dev`의 기존 backend/web image ID를 읽고 변경 전 태그를 별도 rollback 태그로 보존한다. 기존 compose와 비밀 파일을 출력하거나 artifact로 업로드하지 않는다. 데이터/볼륨 삭제 명령은 사용하지 않는다.
3. 검증한 두 이미지를 `docker save`→SSH 전송→`docker load`하고 새 버전 태그를 지정한다. SSH private key와 운영 env는 이미지/저장소/CI에 넣지 않는다.
4. 승인 범위의 match/cluster/web만 교체한다. 현재 동작은 메모리 게임 상태라 cluster 교체 시 살아 있는 게임을 보존한다고 주장할 수 없다. 그래서 사전 0게임 확인과 공지가 필요하다.
5. 공개 HTTPS에서 readiness, 새 합성 게스트3명·방1개·전체 경기/다음 경기/퇴장을 15분 이하 배치로 확인했다. 회원A/B 기존 전적·로그인·역할 권한·로그아웃과 새 정적 bundle 및 운영 TLS/Caddy 헤더도 확인했다. 리플레이·메일/MFA·관리자 UI 전체는 배포 후 반복하지 않았으므로 후속 수동 확인 범위다.
6. 응답 오류 연속, 지연 증가, OOM/restart를 발견하면 새 요청을 중단하고 변경 전 두 image 태그로 동일 서비스만 원복한다. DB migration이 없으므로 역방향 schema 변경은 필요 없다. 원복 후 health와 방/연결 집계를 확인한다.

감사 시작 당시 배포 이미지에는 source SHA를 입증할 OCI label이 없었다. 이번 릴리스는 두 이미지에 `org.opencontainers.image.revision=5c87efd88ecf664581b36e8422538cde8048d7fd`와 저장소 source label을 넣고 로드 후 값을 검증했다. backend 내부 Node v24.21.0/Fastify5.12.5도 실제 실행으로 확인했다.

## 10월 5일 실행 기록

- main fast-forward push 성공: `5a986ef` → `5c87efd`. 최종 보고서 문서 커밋은 배포 코드와 분리한다.
- 지정 VM 외 신규 자원/레지스트리/유료 서비스는 만들지 않았다. 로컬 빌드 → 240,260,096바이트 이미지 archive → SSH 전송 → docker load를 사용했다.
- 최초 관측 및 교체 직전 두 번의 fresh heartbeat에서 worker1/대기방0/경기0/연결0을 필수 확인했다. Redis 장애·오래된 heartbeat·활성 방/연결이면 배포 스크립트가 거부하도록 했다.
- 기존 backend/web은 `switch-azure-backend:rollback-20261005`, `switch-azure-web:rollback-20261005`로 보존했다. 기존 compose/Caddyfile/image ID와 원복 스크립트는 VM의 `/opt/switch-dev/releases/audit-20261005-5c87efd/`에 보존했다.
- match/cluster/web만 새 이미지로 재생성했다. 기존 Redis·PostgreSQL·리플레이·TLS 인증서 볼륨과 환경 파일은 유지했으며 새 migration은 없어 실행하지 않았다.
- match/cluster/web 모두 healthy가 된 뒤 검증한 Caddyfile을 적용하고 Caddy를 재시작했다. Caddy 자체 이미지는 교체하지 않았다. 이후 공개 HTTPS readiness200, 서비스 재시작 횟수0/OOMfalse를 확인했다. 배포 실패 시 이전 이미지·Caddyfile을 복원하는 종료 trap을 준비했고 이번에는 발동하지 않았다.
- 실행 중인 backend image ID: `sha256:b05c589ceb2eed00778834cd4435c01826b096f18dcaa1fd0f6044bbedbd42c7`; web: `sha256:3e67732ebc89336cd36c1d773a633b434126b9e248e8005ab3bb1ce02a11f94f`.
- 배포 후 실제 3인 두 경기 및 응답 헤더 결과는 [Azure 결과](azure-results.md)에 기록한다.

원복 명령은 SSH 접속 후 `sudo sh /opt/switch-dev/releases/audit-20261005-5c87efd/rollback.sh`다. 원복 역시 메모리 경기 상태를 중단하므로 실행 전 활성 경기/방/연결과 사용자 영향을 확인해야 한다. HSTS 관련 주의는 아래와 같다. 자동 CI에는 배포·SSH 접근을 추가하지 않았다.

## 운영 차이와 후속 확인

- Azure의 관리형 PostgreSQL/TLS·Caddy 인증서·Gmail 전달·1GiB VM 자원·실제 인터넷 지연은 내부 runner와 다르다.
- 내부 브라우저 URL은 `http://web`이다. Chromium에 그 한 origin만 secure context로 취급하는 개발용 옵션을 줘 운영 HTTPS에서 제공되는 WebCrypto를 노출한다. 맵 해시·리플레이 서명·서버 인증·Origin 검증을 건너뛰지 않는다. 로컬 인증서/TLS, Secure 쿠키의 실제 HTTPS 전달, mixed-content 차단을 이 검사로 입증하지 않는다.
- audit은 최대2 worker 증감 시험을 하지만 현재 Azure는 최소 비용 구성1 worker/방2개다. 검증 결과를 VM 용량 확장 승인으로 해석하지 않는다.
- 자동 증감은 같은 컨테이너 안의 게임 프로세스를 늘리고 줄이는 기능이다. Azure VM 개수를 늘리는 autoscale이나 클라우드 자원 증설 기능으로 표현하지 않는다.
- 결과 outbox crash durability와 장애 중 이관의 원자성은 미해결이다. 현재 제한된 정상 경로 성공만으로 운영 중 무손실 이동을 보장하지 않는다.
- 한도/알림/무료 사용량은 Azure 과금 화면에서 별도 확인해야 한다. 이번 점검은 새 Azure 자원을 만들거나 사양을 바꾸지 않았다.

## Caddy 보안 헤더 적용 및 원복

현재 Caddy는 admin API를 끈 구성이다. 10월 5일 배포 승인에 따라 `deploy/azure/Caddyfile`을 적용하고 Caddy 컨테이너를 재시작했다. 기존 Caddyfile과 TLS 인증서 데이터 볼륨은 보존했다. 로컬과 VM 양쪽에서 네트워크 없는 기존 Caddy 이미지로 구성 문법 검증이 성공했다.

원복 시 기존 Caddyfile과 이전 서비스 이미지로 돌아간다. HSTS는 이미 방문한 브라우저에 남을 수 있으므로 HTTPS를 계속 제공해야 한다. HSTS 자체를 취소해야 한다면 유효한 HTTPS 응답에 `Strict-Transport-Security: max-age=0`을 보내는 별도 변경이 필요하다. 하위 도메인 포함과 preload는 이번 정책에 넣지 않았다.

## 10월 5일 2차 배포 — `26f1dff`

소유자가 병합과 Azure 배포를 지시했다. 이 릴리스는 codex의 결과 내구성·방 이관 펜싱(`541e97a`)과 Claude의 UI 점검·성능·디자인 체계·2층 사람 확인·폰 가로 고정·문구 정리를 함께 담는다.

- 배포 전 격리 감사 core 게이트 통과(브라우저 10/10, 단위 전부). 1회차에서 테스트 헬퍼 3건(증명 없는 API 로그인, 검증 응답 대기 순서 경쟁)이 실패해 고친 뒤 재실행했다. 제품 코드 결함은 없었다.
- `main` fast-forward push: `e6fab99` → `26f1dff`.
- 이미지는 푸시된 커밋을 `git archive`한 내용 그대로 빌드했고 두 이미지에 `org.opencontainers.image.revision=26f1dffa152f93af2326c4afbb3df2fffe5beb71` 라벨을 넣었다. VM에서 로드 후 라벨을 다시 확인했다.
- 교체 전 두 번의 idle 확인에서 worker1/대기방0/경기0/연결0. `.audit/deploy-followup.sh`로 match/cluster/web만 교체했다. 설정(compose·Caddyfile·환경 파일)과 볼륨은 바꾸지 않았고 마이그레이션은 없다. 결과 저널은 기존 `replay_data` 볼륨(`/app/replays/.result-outbox`)에 쌓인다.
- 실행 중 이미지: backend `sha256:dcc81f7fbc1c…`, web `sha256:3ba1af582ff7…`. 재시작 0, OOM 없음.
- 공개 HTTPS 확인: `/api/health/ready` 200, 보안 헤더 유지, 실제 Chromium에서 로그인 시 `human-challenge` 201 → 충전 후 `verify` 201 → `login` 응답(가짜 계정이라 401)까지 약 1.2초, 페이지 오류 0, 세로 폰 에뮬레이션에서 대기실 90° 회전 확인.
- 확인하지 않은 것: 실제 메일 발송(가입·재설정), 실제 폰 기기의 가로 고정·터치 조작, 다인 실경기. 이 배포 후 친구 테스트에서 확인이 필요하다.

**API 계약 변경 주의:** 로그인은 이제 시도마다 사람 확인 증명이 필요하다. 클라이언트와 서버를 반드시 함께 교체한다(이 스크립트가 그렇게 한다).

원복: SSH 접속 후 `sudo sh /opt/switch-dev/releases/followup-26f1dff/rollback.sh` — 이전 `5c87efd` 이미지로 match/cluster/web을 되돌린다. 메모리 경기 상태가 끊기므로 활성 방·연결을 먼저 확인한다.

## 10월 5일 후속 배포 — `9f8e194`, `31829d6`

같은 절차(`.audit/deploy-followup.sh`, 교체 전 idle 2회 확인, 원복 태그 보존)로 두 번 더 배포했다. 둘 다 격리 감사 core 게이트 통과 후다.

- `9f8e194`: 플레이테스트 수정 — 색약 모드별 스킬 아이콘, 로고 토큰화, 버튼 확대 효과 복원, 방 코드 표시, 빈 방 목록 안내, 대기실 조작 방식 공유(`lobby.setControl`, 공유 계약 추가), 폰 스위치 쿨타임, 훈련장 미니맵 키·아이콘·설정 닫기.
- `31829d6`: "조작 설정" 탭(키보드/터치 전환), 요소별 조이스틱 배치와 전체 화면 편집기, 모바일 설정 레이아웃 수정. 게이트에서 게임 서버 테스트 하나가 시각을 두 번 읽는 경쟁으로 깨져 픽스처를 고쳤다(제품 코드 변경 없음).

원복: `sudo sh /opt/switch-dev/releases/followup-31829d6/rollback.sh`(직전 `9f8e194`로), 더 이전은 같은 폴더 규칙의 `followup-9f8e194`, `followup-26f1dff`.
