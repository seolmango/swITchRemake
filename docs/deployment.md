# 배포와 운영

지원하는 배포 형태는 하나다(BASE.md §14.6). 이미지 두 개를 Docker Compose로 띄운다.

| 이미지 | 내용 | 기본 명령 |
| --- | --- | --- |
| `Dockerfile.backend` | 서버 4종을 빌드한 하나의 이미지 | `node server-match/dist/main.js` |
| `deploy/Dockerfile.web` | 클라이언트 빌드 + nginx(`deploy/nginx.conf`) | nginx |

같은 백엔드 이미지를 서비스마다 다른 명령으로 띄운다.

| 서비스 | 하는 일 |
| --- | --- |
| `migrate` | DB 마이그레이션 후 종료. 종료 코드 0이 정상이다 |
| `match` | 매칭 서버 :3000 |
| `cluster` | 게이트웨이 :4100 + 감독자. 인게임 서버는 감독자가 같은 컨테이너 안에 자식 프로세스로 띄운다 |
| `web` | 정적 클라이언트. `/api/*`는 `/api`를 떼고 match로, `/game-ws*`·`/map-bundles/*`·`/replays/*`는 cluster로 넘긴다 |

| Compose 파일 | 용도 |
| --- | --- |
| `docker-compose.yml` | 로컬 개발용 PostgreSQL·Redis만 (`npm run db:up`) |
| `deploy/compose.yml` | 서버 한 대에 전부. 아래 "서버 한 대에 배포" (`npm run stack:up`) |
| `deploy/azure/compose.yml` | 지금 운영 중인 Azure VM. DB는 관리형 PostgreSQL |
| `deploy/verify/compose.yml` | `npm run verify`의 일회용 검증 스택 ([deploy/verify/README.md](../deploy/verify/README.md)) |

## 서버 한 대에 배포

Docker(Compose 포함)와 Node.js 24가 있는 리눅스 서버 하나면 된다. 저장소를 받은 뒤:

```sh
npm run setup -- deploy   # .env.deploy 생성. 도메인과 메일 계정을 묻는다
npm run stack:up          # 설정 검사 → 이미지 빌드 → 실행. 끝나면 주소를 알려 준다
```

- **도메인을 주면** Caddy가 함께 떠서 80/443을 열고 Let's Encrypt 인증서를 자동으로 받는다. 그 도메인의 DNS가
  이 서버를 가리키고 80/443이 인터넷에서 열려 있어야 한다. `APP_ENV=prod`가 되어 메일(SMTP)이 필수다 — 실제
  사용자가 가입 메일을 받아야 하기 때문이다.
- **도메인을 비우면** 이 머신의 http://localhost:8080 에서만 열리는 테스트 스택이다(메일은 보내지 않는다).
  다른 기기에서 HTTP로 붙어서는 안 된다 — 클라이언트가 `crypto.subtle`로 맵·리플레이를 검증하고, 그 API는
  HTTPS나 localhost에서만 있다. 개발자 몇 명이면 SSH 터널로 각자의 localhost:8080에 연결한다.
- `BUILD_ID`에는 지금 커밋이 들어가고(작업 트리가 깨끗하지 않으면 `-dirty`), 이미지에도 커밋 라벨이 붙는다.

```sh
npm run stack:ps
npm run stack:logs          # 뒤에 서비스 이름을 붙일 수 있다(match, cluster …)
npm run stack:down          # 멈춘다. 데이터 볼륨은 남는다
git pull && npm run stack:up   # 업데이트. 마이그레이션은 migrate 서비스가 먼저 돈다
```

`.env.deploy`에는 DB 비밀번호와 암호화 키가 들어 있다. 데이터와 함께 보관하고, 키를 바꾸거나 지우지 않는다 —
바꾸면 기존 암호화 데이터와 로그인 세션을 쓸 수 없다. 볼륨(`postgres_data`, `redis_data`, `replay_data`,
`caddy_data`)을 지우는 `docker compose down -v`는 쓰지 않는다. 컨테이너 서브넷 `172.29.240.0/24`가 VPN과
겹치면 `.env.deploy`의 `INTERNAL_SUBNET`을 바꾼다.

예전 `npm run internal:*`로 띄운 스택이 있다면 `npm run setup -- deploy`가 `.env.internal`을 이어받고
`COMPOSE_PROJECT_NAME=switch-internal`을 넣어 같은 볼륨을 계속 쓴다.

## Azure 운영 서버

친구 테스트용 운영 서버 한 대다. 구성(VM·DB·Caddy·비용 조건)과 점검 명령은
[deploy/azure/README.md](../deploy/azure/README.md)에 있다.

### 검증된 커밋만 배포한다

```text
PR ─ Verify ─ 합치기 → main push ─ Verify ─(통과)→ Deploy ─(production 승인)→ VM
```

- `.github/workflows/verify.yml`: 모든 push와 PR에서 `npm run verify`. 비밀값이 없다.
- `.github/workflows/deploy.yml`: main push의 Verify가 **성공한 뒤에만** 시작한다. 그 커밋에 성공한 Verify가
  있는지 API로 한 번 더 확인하고 나서야 배포용 비밀값을 꺼낸다. 직접 돌릴 때(Actions → Deploy → Run
  workflow)는 SHA를 넣는다. 이 규칙은 `static` 영역의 배포 정책 검사가 고정한다.

GitHub에 한 번 설정할 것(저장소 Settings → Environments → `production`):

| 이름 | 종류 | 값 |
| --- | --- | --- |
| `DEPLOY_SSH_KEY` | secret | VM 접속 개인키 |
| `DEPLOY_KNOWN_HOSTS` | secret | `ssh-keyscan 4.217.193.234`의 결과 |
| `DEPLOY_HOST` | variable | `azureuser@4.217.193.234` |
| `DEPLOY_URL` | variable | `https://switch-dev-193234.koreacentral.cloudapp.azure.com` |
| Required reviewers | 보호 규칙 | 켜 두면 배포마다 사람이 승인해야 진행된다(권장) |

### 배포가 하는 일

`deploy/azure/release.sh <SHA>`가 커밋을 `git archive`로 꺼낸 내용만으로 두 이미지를 굽고(커밋 라벨 포함)
VM에 올린 뒤 `deploy/azure/remote-release.sh`를 실행한다. VM 스크립트는

1. 지금 이미지를 `rollback-<sha7>` 태그로 남기고 `/opt/switch-dev/releases/followup-<sha7>/rollback.sh`를 만든다.
2. Redis heartbeat로 **대기방·경기·연결이 모두 0인지 두 번** 확인한다(`deploy/azure/idle-check.cjs`). 사람이
   있으면 아무것도 바꾸지 않고 실패한다 — 나중에 다시 돌린다.
3. 라벨을 확인한 새 이미지로 `match`·`cluster`·`web`만 다시 만든다. 설정 파일·볼륨·DB는 건드리지 않는다.
4. 셋이 healthy가 되고 `/api/health/ready`가 200인지 본다. 하나라도 실패하면 자동으로 원복한다.

마지막으로 `deploy/azure/post-check.cjs`가 공개 주소의 인게임 서버가 이 커밋의 규칙 버전을 말하는지 확인한다.
같은 명령을 손으로 돌릴 수도 있다(`DEPLOY_HOST=… DEPLOY_SSH_KEY=… DEPLOY_URL=… sh deploy/azure/release.sh <SHA>`) —
그때는 그 커밋의 Verify 통과를 돌리는 사람이 확인한다.

원복: VM에서 `sudo sh /opt/switch-dev/releases/followup-<sha7>/rollback.sh`. 원복도 진행 중인 경기를 끝내므로
사람이 없는지 먼저 본다. 회차별 기록은 [deployment-followup.md](audit-2026-10-04/deployment-followup.md)에 남긴다.

### 주의

- 스키마 변경이 있는 릴리스는 지금 스크립트가 `migrate`를 돌리지 않는다. 그런 릴리스는 VM에서
  `sudo docker compose -f compose.yml run --rm migrate`를 먼저 돌린다. 스키마 변경은 앞뒤 버전이 함께 도는
  시간을 견뎌야 한다(BASE.md §14.6).
- 결과 저널은 `replay_data` 볼륨의 `/app/replays/.result-outbox`에 쌓인다. Redis가 잠시 죽어도 결과가 여기서
  다시 나간다.
- HSTS를 켰으므로 이 도메인은 HTTPS를 계속 제공해야 한다.
