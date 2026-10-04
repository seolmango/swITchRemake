# 격리된 로컬 모사 사용자와 동적 서버 검증

이 도구는 일회용 Docker 감사 스택에서 실제 게스트 인증, HTTP 방 생성/입장,
WebSocket 일회용 표 인증과 정상 binary 입력(10Hz)을 사용한다. Azure와 운영
주소를 사용하지 않는다. `AUDIT_STACK=true`, `APP_ENV=audit`, 내부 `web`,
`redis`, `postgres`, `audit_` DB 이름이 맞지 않으면 실행을 거부한다.
스택 실행기는 로컬 Docker 엔진과 `internal: true` 네트워크를 확인한다.

PowerShell에서 같은 실행 ID를 유지한다. 비밀이 들어 있는 runtime.env를 출력하지 않는다.

```powershell
$env:AUDIT_RUN_ID = 'local-bots'
node scripts/audit-stack.cjs up core
node scripts/audit-stack.cjs bots core run --count 6 --rooms 2 --batch 3 --ramp-ms 13000 --hold-ms 60000 --seed 42
node scripts/audit-stack.cjs bots core status --seed 42
node scripts/audit-stack.cjs down core
```

인증 제한은 그대로 유지되므로 새 게스트 생성 기본 간격은 13초이다. 즉시 사용자
증가를 반복하려면 먼저 인증 풀을 준비한 뒤 재사용한다. 풀은 내부 Redis에서
10분 뒤 만료되고 토큰은 출력하지 않는다. 회원 흐름은 별도의 core 실제 브라우저
검사에서 검증한다.

`run`은 참가자가 3명 이상인 방을 정상 host 명령으로 시작하고 경기 중에
10Hz 입력을 보낸다. 대기실 부하와 이관만 확인하려면 `--wait-only`를 추가한다.
3명 미만인 방은 대기 상태로 유지한다.

```powershell
node scripts/audit-stack.cjs bots core prepare --count 18 --rooms 6 --ramp-ms 13000 --duration-ms 300000 --seed 42
node scripts/audit-stack.cjs bots core run --reuse --count 18 --rooms 6 --batch 6 --ramp-ms 0 --hold-ms 60000 --seed 42
```

`run`은 종료 시 방 퇴장, 소켓 종료, 게스트 로그아웃과 풀 삭제를 수행한다.
Ctrl+C/SIGTERM도 같은 정리를 수행한다. 다른 터미널에서 다음 명령으로 같은 seed의
실행에 중지 표시를 전달할 수 있다. hold 단계는 0.5초 간격으로 표시를 확인한다.
풀을 준비하는 단계는 Ctrl+C로 중지한다. `status`는 풀을 보존한다.

```powershell
node scripts/audit-stack.cjs bots core stop --seed 42
```

상한은 사용자 24명, 방 8개(방당 최대 8명), batch 8명, ramp 60초,
hold 180초, 실행당 300초이다. HTTP 요청은 8초, WS handshake는 3초,
재접속은 4.5초로 제한한다. 입력 방향은 seed와 packet sequence로 결정된다.
방 입장은 순서대로 승인받고 batch 사이 간격을 적용한다. `batch`는 동시에
보내는 요청 수를 뜻하지 않는다. 이전 검사가 같은 IP의 인증 창을 사용했으면
실제 429 응답의 Retry-After 헤더/본문을 존중하며 최소 13초 기다린다. 대기와
다음 요청이 남은 예산을 넘으면 중단하므로 큰 prepare는 시간 상한에 도달할 수 있다.
퇴장과 소유권 해제가 heartbeat를 사이에 두고 완료되는 경우 로그아웃은 최대
6초 동안 재시도하며, 완료하지 못하면 성공으로 표시하지 않는다.

동적 서버 검사는 다른 경기 검사와 동시에 실행하지 않는다.

```powershell
node scripts/audit-stack.cjs scaling extended
```

`scaling.spec.ts`는 실제 6 게스트로 서버 1→2→1, 새 서버의 대기실 이관과
재접속, 원래 서버의 3인 경기 유지와 이관된 방의 실제 3인 경기 및 PostgreSQL
결과 참가자 각각 3명을 검사한다. 이관된 active claim을 원래 TTL인 30초가 지난
뒤에도 확인한다. 빠른 로컬 검증 정책은 최소 1/최대 2, 증설 평균부하 3, 축소 1.3,
cooldown 5초를 사용한다. 인증·입력 제한을 낮추지 않는다. Redis phase marker와
컨테이너 `/proc`의 게임 child PID를 함께 수집해 heartbeat와 실제 프로세스
증감을 구별한다. 테스트 통과 결과와 잔여 분산 소유권 위험은 감사 보고서에서
구분한다.
