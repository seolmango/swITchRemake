# Azure 학생 개발 서버

2026-10-04 배포 구성. 친구 테스트용이며 자동 종료 없이 실행한다.

- 게임: https://switch-dev-193234.koreacentral.cloudapp.azure.com/
- 관리자: https://switch-dev-193234.koreacentral.cloudapp.azure.com/admin
- 로그인: `/login`, 비밀번호 변경: `/change-password`
- 리소스 그룹: `switch-dev-rg`, 지역: Korea Central
- VM: `switch-dev-vm`, Ubuntu 24.04 x64, `Standard_B2ats_v2` (2 vCPU / 1 GiB)
- 공인 IPv4: `4.217.193.234`, Standard static, 기존 IP에 무료 DNS 레이블 사용
- OS 디스크: Premium SSD LRS P6 64 GiB, 기존 디스크에 2 GiB swap
- PostgreSQL: `switch-dev-pg-193234`, PostgreSQL 16, B1ms / 32 GiB
- VM 작업 경로: `/opt/switch-dev`

## 비용 조건

계정에서 Linux B2ats_v2 750시간/월, PostgreSQL B1ms 750시간/월 및 데이터·백업 각각 32 GiB, P6 관리 디스크 무료 할당을 확인했다. 무료 혜택 유효 기간과 사용량 범위 안에서 적용된다. 31일 연속 실행은 각각 744시간이다. 같은 무료 할당을 쓰는 추가 리소스를 만들면 합산 사용량을 확인해야 한다.

Standard IPv4는 무료 적용을 확정하지 못해 **$0.005/시간, 월 $3.60~$3.72**로 예산을 잡았다. 목표 추가 비용 한도는 월 $5다. 인터넷 송신 무료 100 GB/월을 넘거나 DB/백업 무료 용량을 넘으면 추가 비용이 발생할 수 있다. DB 자동 저장소 증가·고가용성·지역 중복 백업은 껐다. 유료 레지스트리, Bastion, NAT Gateway, 로드 밸런서, Log Analytics는 만들지 않았다.

**비용 예산 알림은 아직 생성하지 않았다.** 신규 구독의 비용 화면에 데이터와 통화가 명확히 나오지 않아 $5 / 원화 단위를 혼동한 설정을 저장하지 않았다. 비용 데이터가 표시되면 실제 무료 적용과 통화를 확인해 알림을 설정해야 한다. 예산 알림 자체는 과금을 강제로 중단하지 않는다.

- [Azure IP 주소 가격](https://azure.microsoft.com/en-us/pricing/details/ip-addresses/)
- [Azure 인터넷 송신 가격](https://azure.microsoft.com/en-us/pricing/details/bandwidth/)
- [Azure 학생 무료 서비스](https://azure.microsoft.com/en-us/free/students/)

## 실행 구조

`Caddy`가 80/443을 받아 HTTPS 인증서를 자동 관리한다. `/api/*`는 match, `/game-ws*`, `/map-bundles/*`, `/replays/*`는 cluster, 나머지는 정적 웹으로 보낸다. Redis·DB·게임 내부 포트는 VM 인터넷 포트로 공개하지 않는다. PostgreSQL 방화벽은 VM 공인 IP 하나만 허용한다. DB 연결은 인증서 검증을 켠 TLS를 사용한다.

최소 구성으로 게임 서버 프로세스 1개, 방 최대 2개를 설정했다. 훈련장도 방 하나를 사용한다. 일반 경기는 기존 게임 규칙상 3명 이상이 필요하다. 2026-10-04 실제 Azure 3인 브라우저 연속 경기와 4인 연결 흐름을 검증했으며, 대규모 부하 성능까지 확인한 것은 아니다. 수정 원인·증거·미검증 범위는 [검증 기록](VERIFICATION-2026-10-04.md)을 참조한다.

SSH는 키로만 로그인하며 사용자의 요청에 따라 모든 IP에서 TCP 22를 허용했다. 웹 NSG 규칙 `Allow-Web-80-443`은 priority 1010, TCP 80/443, source Any다.

## 확인한 범위

- 공개 HTTPS 인증서 검증, `/api/health/ready` 정상 응답
- 모든 상시 컨테이너 실행, match·cluster·Redis·web 상태 정상
- PostgreSQL 관리자/앱 계정 TLS 접속, 게임 스키마 마이그레이션 완료
- 실제 Chrome에서 방 생성·실시간 대기실·훈련장 렌더링·스킬 입력 확인
- 첫 관리자 계정 생성 및 로그인, `/api/admin/me`와 `/api/admin/overview` 조회 성공

SMTP 자격 증명은 설정됐지만 실제 인증 메일 발송은 별도 검증하지 않았다. 게임의 약관 동의 기록은 관리자 초기 생성 시 채우지 않았으며 실제 사용자 동의만 기록한다.

## 점검 및 재시작

다운로드한 키로 `azureuser@4.217.193.234`에 SSH 접속한 뒤:

```sh
cd /opt/switch-dev
sudo docker compose -f compose.yml ps
curl --fail https://switch-dev-193234.koreacentral.cloudapp.azure.com/api/health/ready
sudo docker compose -f compose.yml logs --tail=80 match cluster caddy
sudo docker stats --no-stream
free -m
```

설정을 바꾼 서비스만 재시작한다. 예를 들어 match만 재시작하려면:

```sh
sudo docker compose -f compose.yml restart match
```

전체 구성 시작:

```sh
sudo docker compose -f compose.yml up -d
```

DB 스키마 변경 배포 시 먼저 기존 SQL 마이그레이션을 검토하고, 이미지를 갱신한 뒤:

```sh
sudo docker compose -f compose.yml run --rm migrate
sudo docker compose -f compose.yml up -d --no-deps --force-recreate match cluster
```

`down -v`는 Redis·리플레이·인증서 볼륨을 삭제하므로 사용하지 않는다. VM을 중지해도 디스크와 공인 IP 비용은 계속될 수 있다.

## 재배포와 비밀 값

현재 이미지는 로컬 PC에서 `Dockerfile.backend`, `deploy/Dockerfile.web`으로 빌드한 `switch-azure-backend:local`, `switch-azure-web:local`이다. `docker save`로 내보내 SSH로 전송하고 VM에서 `docker load`한 뒤 서비스를 재생성한다. 소스 변경만으로 실행 이미지가 자동 갱신되지는 않는다.

`bootstrap-vm.sh`는 Ubuntu/Docker/swap 준비, `provision-db.py`는 DB/앱 역할 준비, `prepare-runtime.py`는 서비스별 환경 파일 작성, `migrate.cjs`는 마이그레이션을 담당한다. 초기 관리자는 `bootstrap-admin.cjs`에 소유자가 지정한 이메일·닉네임·bcrypt 해시를 JSON stdin으로 전달해 만든다. 기존 이메일 또는 닉네임이 있으면 변경 없이 중단하며 새 관리자 생성은 감사 로그에 남긴다.

VM의 `secrets/`와 `.env.match`, `.env.cluster`, `.env.redis`에는 자격 증명이 있다. 권한은 디렉터리 0700 / 파일 0600이며 Git과 이미지에 넣지 않는다. `prepare-runtime.py`는 생성한 JWT·Redis·암호화·리플레이 키를 유지해 설정 갱신 때마다 임의로 회전시키지 않는다. 운영 환경 파일이나 비밀 값을 출력하는 `docker compose config`, 환경 변수 전체 출력, 로그 공유는 피한다.

관리자 초기 비밀번호는 소유자가 직접 변경한다. 이 문서에는 로그인 이메일이나 비밀번호를 기록하지 않는다.
