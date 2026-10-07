# 검증 스택 내부

`npm run verify`가 만드는 일회용 Docker 스택의 구조와, 스택을 띄워 둔 채 한 부분씩 고쳐 보는 법이다.
무엇을 검사하는지(영역)는 [CONTRIBUTING.md](../../CONTRIBUTING.md#표준--테스트)에 있다.

## 격리

- 실제 클라이언트와 서버 전부를 이미지로 굽고, 실제 PostgreSQL을 마이그레이션하고, 비밀번호가 걸린 Redis,
  메일을 받아 두는 Mailpit(SMTP), 실행마다 따로인 리플레이 볼륨을 쓴다. 비밀값은 실행마다 새로 만든다.
- 저장소의 `.env`를 읽지 않고, 떠 있는 서버를 재사용하지 않으며, 클라우드 자격 증명을 물려받으면 시작을 거부한다.
- 실행 중 네트워크는 `internal`이라 바깥으로 길이 없다. Node 소켓 목적지는 스택 안 서비스 이름만 허용하고
  (`scripts/verify/egress.cjs`), 브라우저도 바깥 주소 요청을 막는다. 이미지 빌드(npm·apt·Chromium 내려받기)에만
  인터넷이 필요하다.
- 컨테이너마다 CPU·메모리·프로세스 수 상한이 있고 권한을 내려 둔다. 외부 이미지는 digest로 고정한다.
  이 성질들은 `static` 영역의 배포 정책 검사(`scripts/verify/deployment-policy.cjs`)가 고정한다.
- 브라우저 출처 `http://web`에만 보안 컨텍스트를 줘서 실제 WebCrypto로 맵 해시·리플레이 서명을 검증한다.
  TLS·인증서·운영 프록시 설정은 이 스택이 확인하지 않는다.

## 순서

1. 추적 중인 파일에서 비밀값 모양을 찾는다(`scripts/verify/secrets.cjs`).
2. backend·web·runner 이미지를 굽는다. backend를 구운 직후 운영 의존성의 high/critical 취약점이 있으면 멈춘다.
3. DB·Redis·Mailpit → 마이그레이션(종료 코드 0 필수) → 매칭·인게임 → web 순으로 띄우고 각각 healthy를 기다린다.
4. runner 컨테이너가 영역별 단계를 차례로 돈다(`scripts/verify/runner.cjs`). 앞 단계가 실패하면 뒤 단계는
   `not-run`으로 남는다.
5. 확장 점검이면 인게임 서버 1 → 2 → 1 증감, DB·Redis 중단과 복구, 매칭 서버 재시작, 리플레이 쓰기 실패와
   복구, 멈춘 워커가 새 워커를 낳지 않는지를 더 본다.
6. 증거를 `e2e/artifacts/audit/<실행 id>/`로 모으고(비밀값·토큰을 지운 텍스트와 화면 PNG만), 이 실행이 만든
   컨테이너·볼륨만 지운다. `docker prune`은 쓰지 않는다.

## 띄워 두고 고치기

같은 `AUDIT_RUN_ID`로 이어서 부른다. PowerShell은 `$env:AUDIT_RUN_ID = 'mine'`.

```sh
export AUDIT_RUN_ID=mine
node scripts/verify/stack.cjs up core                      # 굽고 띄우기만 한다
node scripts/verify/stack.cjs test core account            # 단계 실행(영역 지정 가능)
node scripts/verify/stack.cjs browser core account         # 브라우저 영역 하나
node scripts/verify/stack.cjs browser core account/mfa.spec.ts --grep 백업   # 파일 하나, 이름 일부
node scripts/verify/stack.cjs refresh core                 # 테스트 코드만 고쳤을 때 runner 갱신
node scripts/verify/stack.cjs refresh-web core             # 클라이언트만 고쳤을 때
node scripts/verify/stack.cjs refresh-backend core         # 서버 코드만 고쳤을 때(의존성 재설치 없이)
node scripts/verify/stack.cjs rebuild core                 # 전부 다시 굽기
node scripts/verify/stack.cjs down                         # 이 실행의 자원만 지운다
```

`up`은 내부 주소와 런타임 비밀값 파일 경로(`.audit/<실행 id>/runtime.env`)를 알려 준다. 그 파일 내용을
출력하거나 공유하지 않는다. 확장 점검의 개별 단계는 `scaling extended`, `faults extended`,
`stalled-worker extended`로 부를 수 있다.

## 아직 다루지 않는 것

실행 중인 경기가 있는 상태의 네트워크 분단, 경기 전체 길이의 리플레이 쓰기 실패, SMTP 재시도·중복 발송,
자원 고갈, 오랜 기간의 보존 정리, 패킷 손실, 모바일 터치 입력. 이것들은 단위 테스트가 일부만 보며 실제
스택 수준의 검증으로 보지 않는다.

이 스택과 Verify 워크플로는 배포하거나 Azure에 접속하지 않는다. 배포는 별도 Deploy 워크플로가 하고, Verify가
통과한 커밋만 받는다([docs/deployment.md](../../docs/deployment.md)). 2026-10-04~05 감사 기록은
`docs/audit-2026-10-04/`에 있다.
