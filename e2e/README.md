# swITch 사용자 흐름 자동 점검

브라우저를 실제로 몰아서 **사용자가 할 수 있는 모든 행동**을 한 번씩 해 본다. 가입부터
탈퇴까지, 방을 만들고 경기를 하고 도중에 나가는 것까지 훑고 **마지막에 결과 요약만** 찍는다.

단위 테스트가 잡지 못하는 계층 사이 버그가 이 프로젝트의 주된 실패 유형이라 존재한다 —
클라이언트·매칭 서버·인게임 서버·게이트웨이·Redis·Postgres가 다 붙어 있어야만 드러나는 것들.

## 준비

```bash
npm run db:up                      # Postgres + Redis
npm run db:migrate -w server-match  # role 컬럼 등 최신 스키마
npx playwright install chromium    # 최초 1회
```

`.env`의 `EMAIL_TRANSPORT`가 `sink`여야 한다(기본값). 인증 코드는 메일로 나가지 않고
Redis `test:mail:{email}`에 남으며, 점검은 그 값을 읽는다. **실제 발송은 0건이다.**

## 실행

```bash
npm run e2e
```

매칭 서버(3000)·게이트웨이(4100)·클라이언트(5173)는 이미 떠 있으면 그대로 쓰고,
없으면 Playwright가 직접 띄운다. 인게임 서버는 감독자가 부하를 보고 띄운다.

**매칭 서버를 직접 띄워 두고 돌린다면 `RATE_LIMIT_RELAXED=true`가 필요하다.**

```bash
RATE_LIMIT_RELAXED=true npm run match:dev
```

한 IP에서 수십 개 계정을 만들고 지우는데 인증 메일 요청이 IP당 분당 5회라 그대로는 중간부터
전부 실패한다. 한도만 50배가 되고 가드는 그대로 돈다. `APP_ENV=prod`면 서버가 부팅을 거부한다.
Playwright가 직접 띄우는 경우에는 알아서 붙여 준다.

5173을 다른 창이 쓰고 있으면 옆 포트로 돌릴 수 있다:

```bash
E2E_BASE_URL=http://localhost:5174 npm run e2e
```

이때 인게임 서버가 그 origin을 받아 줘야 한다 —
`GAME_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174 npm run cluster:start`

```bash
npm run e2e -- --headed     # 실제로 무엇을 하는지 보면서
npm run e2e -- --grep 가입   # 한 흐름만
npm run e2e:report          # 실패한 흐름의 화면·트레이스
```

## 관리자 흐름

관리자 화면 점검은 계정 하나를 만든 뒤 `scripts/grant-admin.cjs`로 승격시켜서 본다.
따로 준비할 계정은 없다.

## 무엇을 남기나

- 통과한 흐름은 아무것도 남기지 않는다.
- 실패한 흐름만 스크린샷·비디오·트레이스를 `e2e/artifacts/`에 남긴다.
- 만든 계정은 각 점검이 끝나면서 스스로 탈퇴한다. 남는 것은 `matches` 기록뿐이다.
