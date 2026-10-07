# 브라우저 흐름 점검

swITch 표준(`npm run verify`)의 마지막 단계다. 실제 Chromium으로 사용자가 할 수 있는 일을 해 보고, 화면·
HTTP·WebSocket·DB 결과를 함께 확인한다. 단위 테스트가 못 잡는 계층 사이 결함 — 클라이언트, 매칭 서버,
인게임 서버, 게이트웨이, Redis, PostgreSQL이 다 붙어 있어야만 드러나는 것 — 을 잡으려고 있다.

일회용 검증 스택 안에서만 돈다(`playwright.config.ts`가 그 밖에서는 시작을 거부한다). 개발 DB나 운영 주소에
대고 돌지 않는다. 실행 방법과 영역은 [CONTRIBUTING.md](../CONTRIBUTING.md#표준--테스트)에 있다.

## 구조

```text
specs/<영역>/*.spec.ts   영역 폴더 = `npm run verify -- <영역>`의 이름
support/app.ts            화면 조작(가입, 로그인, 방 만들기 …). 로케일 문구로 요소를 찾는다
support/helpers.ts        DB 직접 시드, 격리된 브라우저 컨텍스트, API 로그인
support/mail.ts           스택 안 Mailpit에서 인증 코드 읽기
support/totp.ts           독립 OTP 인증기
```

- 요소는 `data-testid`가 아니라 **화면에 보이는 문구**(`client/src/locales/ko.json`)로 찾는다. 버튼 이름이
  사라지면 점검도 못 찾는 것이 맞다 — 접근성 이름이 곧 계약이다.
- 흐름은 순서대로 하나씩 돈다. 방 배정처럼 전역 상태를 만지는 흐름이 서로를 흔들면 무엇이 깨졌는지 알 수 없다.
- 재시도하지 않는다. 흔들리는 점검은 통과해도 정보가 없다 — 흔들린다는 사실이 결과다.
- 스택 안에서는 속도 제한 한도만 넓힌다(`RATE_LIMIT_RELAXED`). 한 IP에서 계정을 수십 개 만들기 때문이다.
  제한 자체는 매칭 서버 단위 테스트가 확인한다.
- `specs/scaling/`은 인게임 서버 프로세스 증감을 보므로 확장 점검(`npm run verify:extended`)에서만 돈다.
