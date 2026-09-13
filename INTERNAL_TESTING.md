# Docker로 내부 테스트하기

이 구성은 서비스 업체를 정하기 전, 한 머신에서 전체 앱을 실행하는 내부 테스트용이다.
기존 개발용 `.env`, DB, Redis와 분리된 `.env.internal` 및 Docker 볼륨을 사용한다.
기본으로 호스트의 `127.0.0.1:8080`만 연다. 실행만으로 인터넷에 공개되지 않는다.

## 처음 실행

Docker Engine/Compose 또는 Docker Desktop과 Node.js 24를 준비한다. 저장소 루트에서:

```sh
npm run internal:setup
npm run internal:up
npm run internal:ps
```

첫 빌드에는 이미지와 npm 패키지를 받는 시간이 걸린다. `web`, `match`, `cluster`, DB와 Redis가
정상이 되면 <http://localhost:8080>으로 접속한다. `migrate`가 종료 코드 0으로 끝나는 것은 정상이다.
`internal:setup`은 별도 임의 암호·암호화 키를 만들며, 파일이 이미 있으면 덮어쓰지 않는다.
Docker 빌드는 로컬 `.env`와 로그, 리플레이, `node_modules`를 이미지에 넣지 않는다.

Node.js가 없는 서버에서는 다른 머신에서 만든 `.env.internal`을 안전하게 전달하고 아래 명령을 사용한다.

```sh
docker compose --env-file .env.internal -f compose.internal.yml up -d --build
```

## 구성과 데이터

| 구성 요소 | 역할 | 호스트 포트 |
| --- | --- | --- |
| web | 빌드된 클라이언트, Nginx 프록시 | 기본 127.0.0.1:8080 |
| match | 로그인·방·결과 API | 없음 |
| cluster | 게이트웨이·감독자·자동 생성 게임 서버 | 없음 |
| migrate | 시작 전 DB 마이그레이션 | 없음 |
| postgres / redis | 영속 데이터와 세션·방 제어 | 없음 |

브라우저는 한 주소만 사용한다. `/api/`는 접두사를 제거해 match로, `/game-ws`, `/map-bundles/`,
`/replays/`는 경로 그대로 cluster로 전달한다. 나머지 화면 경로는 SPA로 처리한다.
WebSocket 업그레이드 헤더를 명시하며, HTML·서비스 워커는 오래된 버전을 고정 캐시하지 않는다.
프록시 동작 근거: [Nginx WebSocket 문서](https://nginx.org/en/docs/http/websocket.html),
[proxy_pass 문서](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass).

볼륨은 `switch-internal` 프로젝트 안의 `postgres_data`, `redis_data`, `replay_data`다.
중지·재빌드해도 보존된다. 암호화 키가 들어 있는 `.env.internal`도 데이터와 함께 보관한다.
키를 지우고 다시 생성하면 기존 암호화 데이터·로그인 세션을 그대로 사용할 수 없다.

```sh
npm run internal:logs
npm run internal:down
# 코드 업데이트 후 다시 빌드·실행
npm run internal:up
```

`down`에는 데이터 삭제 옵션을 붙이지 않는다. 공유 테스트 데이터를 지우는 초기화는 별도 결정이다.
기본 Docker 서브넷 `172.29.240.0/24`가 VPN 등과 겹치면 `.env.internal`의 `INTERNAL_SUBNET`을
다른 사설 대역으로 정한 뒤 다시 생성한다. 프록시 신뢰 범위도 같은 설정을 따른다.

## 다른 테스터의 접속

**일반 LAN IP의 HTTP 주소만 열면 충분하지 않다.** 클라이언트의 맵 무결성 검증은
`crypto.subtle`을 쓰므로 브라우저가 신뢰하는 HTTPS가 필요하다. `localhost`는 로컬 예외다.
PWA 설치도 보안 컨텍스트가 필요하다.

방법은 다음 중 하나로 정한다.

1. 개발자 소수: SSH 터널 등으로 각자의 `localhost:8080`을 서버의 `127.0.0.1:8080`으로 전달.
   브라우저 주소가 localhost인 상태로 테스트한다. 서버 포트를 공인망에 열 필요가 없다.
2. 내부망·VPN: 내부 DNS 이름과 테스터 기기가 신뢰하는 TLS 인증서를 준비하고 HTTPS 프록시를 앞에 둔다.
   인증서 경고를 우회하는 방식은 설치·맵 검증 테스트를 대신하지 못한다.
3. 인터넷에서 접속: HTTPS에 더해 VPN 또는 인증된 접근 제어로 테스터만 들어오게 한다.
   URL을 비공개로 전달하는 것만으로 접근이 제한되지는 않는다.

외부 HTTPS 프록시는 위 경로 전체와 WebSocket을 전달해야 한다. 실제 브라우저 주소를
`.env.internal`의 `GAME_ALLOWED_ORIGINS`에 스킴·호스트·포트까지 정확히 추가하고 컨테이너를 재생성한다.
`WEB_BIND`는 그 프록시가 접근할 인터페이스에만 맞춘다. 기본 loopback을 무조건 `0.0.0.0`으로 바꾸지 않는다.
이 저장소는 인증서 발급, VPN 가입 또는 클라우드 방화벽 설정을 자동으로 수행하지 않는다.

## 계정과 메일

Docker DB에는 기존 로컬 테스트 계정이 복사되지 않는다. 먼저 게스트로 방·훈련장 흐름을 확인할 수 있다.
기본 `EMAIL_TRANSPORT=sink`는 메일을 보내지 않으므로 실제 테스터가 이메일 인증을 완료할 수 없다.
가입·이메일 2차 인증·비밀번호 재설정까지 테스트하려면 실제 메일 설정이 필요하다.
현재 메일 전송 구현은 Gmail SMTP(`smtp.gmail.com:465`)를 사용한다.

```dotenv
EMAIL_TRANSPORT=smtp
SMTP_USER=실제_발신_계정
SMTP_PASSWORD=SMTP용_앱_비밀번호
```

인터넷에 연결되는 배포에서 운영 모드를 쓰려면 `APP_ENV=prod`, `RATE_LIMIT_RELAXED=false`,
실제 SMTP와 HTTPS를 함께 설정한다. prod에서는 sink와 완화된 속도 제한으로 부팅할 수 없고,
로그인·신뢰 기기 쿠키가 Secure가 되므로 HTTP로 인증을 시험하면 안 된다.
기본 dev 설정은 로컬·격리된 테스트 시작점이며 공개 운영 설정을 대신하지 않는다.

## 공유하기 전 남은 확인

- 테스터의 접속 방식, 서버 운영체제, 주소·TLS·접근 제한 결정.
- 새 환경의 테스트 계정 및 실제 메일 수신 흐름 준비.
- 다른 기기 3대 이상으로 같은 방 참가 → 방장 슬롯 변경 → 경기 종료 → 결과 조회 → 재접속 확인.
- 실제 모바일에서 역할 전환·재탄생·이모지·미니맵·설정 창과 다크/라이트/고대비 화면 확인.
- 설치한 PWA가 업데이트 후 최신 클라이언트로 바뀌는지 확인.
- 재시작과 DB 백업·복구, 리플레이 보관·삭제 확인. 로컬 리플레이 저장소는 단일 호스트용이다.
- 의존성 감사 결과 검토 및 필요한 업데이트. 이미지의 개발 도구 제거·이미지 digest 고정·자원 제한·
  클라우드 모니터링과 다중 호스트 배포는 이번 내부 테스트 구성에 포함하지 않았다.

실제 공유 환경의 다중 기기·HTTPS·메일 검증은 로컬 단위 테스트나 이미지 빌드만으로 완료됐다고 보지 않는다.

## 남은 의존성 업데이트

2026-09-13의 `npm audit --omit=dev`는 3건(높음 1, 보통 2)을 보고했다. 아직 버전을 변경하지 않았다.
Nodemailer 9.0.6은 9.1.1 이상으로 올릴 수 있다. Fastify 5.11.3은 5.12.1 이상에 수정이 있지만,
현재 Nest 어댑터가 버전을 고정하므로 어댑터 업그레이드 또는 scoped override 후 인증·요청 제한을
다시 검증해야 한다. 현재 sink는 메일 파서를 사용하지 않으며 프록시 신뢰는 숫자 홉 수가 아닌
주소 목록을 사용하지만, 공유 환경으로 옮기기 전 업데이트 검토를 남겨 둔다.
근거: [메일 파서 권고](https://github.com/nodemailer/nodemailer/security/advisories/GHSA-2x7j-588g-ccc2),
[Fastify 스키마 권고](https://github.com/advisories/GHSA-w2qp-rph6-63g4),
[프록시 신뢰 권고](https://github.com/fastify/fastify/security/advisories/GHSA-3m5p-2c4r-xxw2).
