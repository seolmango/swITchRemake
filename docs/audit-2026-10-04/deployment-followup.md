# 승인 후 수동 배포 및 원복 준비

이 문서는 실행 계획이다. 이번 감사에서 Azure 서비스 배포·재시작·설정/암호 변경은 하지 않았다. 현재 친구 사용자 데이터 및 세션을 변경하지 않는다.

## 검증한 변경의 배포 조건

최종 core Actions가 통과한 commit SHA와 extended/local 결과를 선택하고, 같은 소스로 backend/web 이미지를 로컬에서 빌드한다. `Dockerfile.backend`, `deploy/Dockerfile.web`은 audit과 같은 Node digest/npm11.21.0을 사용하도록 고정했다. 릴리스 이미지 내 Fastify5.12.5 및 lockfile 버전 확인이 필요하다. 자동 Actions 배포는 없다.

이번 변경에 스키마 migration 추가는 없다. 기존 DB/Redis/JWT/암호화/리플레이 서명 키를 그대로 사용한다. SMTP 옵션을 추가했지만 운영 미지정 시 기존 Gmail 기본값을 유지한다. 관리자 암호 변경은 소유자만 수행한다.

## 승인받을 실행 단위

1. 실제 사용 중인 방/경기/연결 수를 읽기 전용으로 확인한다. active 경기를 중단하지 않는 시간을 소유자와 정한다.
2. `/opt/switch-dev`의 기존 backend/web image ID를 읽고 변경 전 태그를 별도 rollback 태그로 보존한다. 기존 compose와 비밀 파일을 출력하거나 artifact로 업로드하지 않는다. 데이터/볼륨 삭제 명령은 사용하지 않는다.
3. 검증한 두 이미지를 `docker save`→SSH 전송→`docker load`하고 새 버전 태그를 지정한다. SSH private key와 운영 env는 이미지/저장소/CI에 넣지 않는다.
4. 승인 범위의 match/cluster/web만 교체한다. 현재 동작은 메모리 게임 상태라 cluster 교체 시 살아 있는 게임을 보존한다고 주장할 수 없다. 그래서 사전 0게임 확인과 공지가 필요하다.
5. 공개 HTTPS에서 readiness, 새 합성 게스트 3명·방1개·전체 경기/다음 경기/퇴장을 15분 이하 배치로 확인한다. 회원용 전적/리플레이/메일/MFA와 관리자 화면은 소유자 테스트 계정으로 추가 확인한다. 정적 bundle caching 및 원래 운영 TLS/Caddy도 확인한다.
6. 응답 오류 연속, 지연 증가, OOM/restart를 발견하면 새 요청을 중단하고 변경 전 두 image 태그로 동일 서비스만 원복한다. DB migration이 없으므로 역방향 schema 변경은 필요 없다. 원복 후 health와 방/연결 집계를 확인한다.

현재 배포된 backend/web의 Docker image ID는 이번 SSH 조회로 확인했지만 빌드 SHA를 입증할 OCI source label은 확보하지 못했다. 따라서 로컬 HEAD를 현재 Azure SHA라고 쓰지 않는다. 실제 배포 시 검증 SHA를 image label/별도 release 기록에 남겨야 한다.

## 운영 차이와 후속 확인

- Azure의 관리형 PostgreSQL/TLS·Caddy 인증서·Gmail 전달·1GiB VM 자원·실제 인터넷 지연은 내부 runner와 다르다.
- 내부 브라우저 URL은 `http://web`이다. Chromium에 그 한 origin만 secure context로 취급하는 개발용 옵션을 줘 운영 HTTPS에서 제공되는 WebCrypto를 노출한다. 맵 해시·리플레이 서명·서버 인증·Origin 검증을 건너뛰지 않는다. 로컬 인증서/TLS, Secure 쿠키의 실제 HTTPS 전달, mixed-content 차단을 이 검사로 입증하지 않는다.
- audit은 최대2 worker 증감 시험을 하지만 현재 Azure는 최소 비용 구성1 worker/방2개다. 검증 결과를 VM 용량 확장 승인으로 해석하지 않는다.
- 자동 증감은 같은 컨테이너 안의 게임 프로세스를 늘리고 줄이는 기능이다. Azure VM 개수를 늘리는 autoscale이나 클라우드 자원 증설 기능으로 표현하지 않는다.
- 결과 outbox crash durability와 장애 중 이관의 원자성은 미해결이다. 현재 제한된 정상 경로 성공만으로 운영 중 무손실 이동을 보장하지 않는다.
- 한도/알림/무료 사용량은 Azure 과금 화면에서 별도 확인해야 한다. 이번 점검은 새 Azure 자원을 만들거나 사양을 바꾸지 않았다.
