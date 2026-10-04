# Azure 일회성 검증 — 2026-10-04

**제한된 정상 3인 여정과 소유자 회원 권한 검사 통과. 종합 전체 기능 완료 아님.** 운영 배포·재시작·DB 직접 수정·장애 주입은 하지 않았다.

## 공통 제한

현재 코드와 첫 화면에서 최초 목록을 기록한 뒤 실행했다. 기존 브라우저 계정은 사용하지 않았다. oneoff 설정은 CI를 거부하며 소유자 일회성 opt-in, worker1/retry0, 전체10분, 음소거, trace/video off를 강제한다. 각 배치는 방1개·독립 플레이어3명만 사용했다. 공개 HTTPS/WSS로만 앱을 검증했고 SSH는 상태 조회만 했다.

## 게스트 배치

독립 게스트3명으로 비공개 방 생성→코드/암호 참가→TestMap1→준비/시작→full map/3인 roster→키보드 이동·스킬 입력→전체 경기→3개 결과표와 저장 결과 API 일치→자동 로비→다음 경기→각자 퇴장을 실행했다. Playwright **1 passed (2.7m)**. 이 배치는 별도 HTTP 검사 요청이 없었다.

초기 두 시도는 잘못된 비밀번호 label과 준비시간보다 짧은 expect 제한으로 실패했다. 테스트 오류이며 제품 결함으로 세지 않았다. 자동 승인 검토가 방 정리 증거 부족을 이유로 재실행을 거절하여, SSH 집계로 11:26:55Z 0방/0연결을 확인한 후 승인된 재실행을 했다. 11:31:53Z에도 0방/0연결, match/cluster restart0/OOMfalse였다. 메모리 스냅샷 cluster92.12/384MiB, match75.27/280MiB는 용량·성능 보장이 아니다.

## 회원 가입 및 회원2 + 게스트1 배치

소유자가 지정한 두 메일함으로 실제 CAPTCHA를 거쳐 인증 메일을 발송하고, 사용자가 전달한 코드로 새 합성 회원A/B만 생성했다. 정상 서비스 API가 동의와 인증 코드를 검증하여 각각201을 반환했다. 최초 생성 암호 길이가 UI의20자 상한을 넘어서 제출 버튼이 비활성인 테스트 오류를 수정했다. 가입 완료 요청은 API로 수행했으므로 Azure 가입 UI 전체 성공으로 표현하지 않는다. 실제 외부 메일 수신은 두 주소만 확인했다. 주소·암호·코드는 공개 보고서나 저장소에 포함하지 않는다.

12:19:58Z 시작 배치에서 회원2명+게스트1명이 비공개 방1개로 위와 같은 전체2경기/퇴장을 수행했다. 두 경기 모두 권위 snapshot의 이동 변화, 3인 결과표, 저장 결과 API가 일치했다. 160초 동안 브라우저 정적 요청156, 필수API76, WS연결3, 정상클라이언트 송신934였다. 별도HTTP1회 뒤 테스트에 보관한 초기 토큰이401이라 **Playwright 실행 전체는 실패**다. 이 실패 기록을 통과로 덮어쓰지 않는다. JWT수명은900초이며, 코드상 페이지 재진입의 refresh가 옛 세션을 폐기하므로 단순 시간 만료와 구분한다. 이후 테스트 helper가 실제 브라우저의 현재 Authorization을 따르도록 수정했다.

별도 직렬 확인에서 새 로그인 후 A/B 각각 games=2, 두 경기의 전적 존재, 관리자 개요403, B의 A 세션 삭제404와 A 접근 유지, 권한 있는 리플레이45,234바이트 다운로드, 로그아웃 후401을 **통과**했다. 성공 배치17요청, 요청 간격최소1.2초였다. 직전 API fixture는 body 없는 DELETE에도 JSON Content-Type을 붙여400으로 중단됐고 이를 수정했다. 실패 시 무한 재시도하지 않았다.

회원 배치 전후 0방/0연결을 확인했다. 최종 API 검사 후 match/cluster 모두 running=true, restart0, OOMfalse였다. 기존 사용자 데이터·세션은 조작하지 않았다. 새 테스트 계정은 보존하며 자격 증명은 저장소 밖의 접근 제한 파일에만 있다.

## 증거 연결

Git에서 제외한 로컬 증거:

- `e2e/artifacts/azure-guest-baseline/azure-limited-live-batch-p-e87bf-complete-rounds-and-cleanup/round-{1,2}-synthetic-result.png`: 게스트 결과 화면.
- `e2e/artifacts/independent-azure/azure-limited-live-batch-p-6654c-complete-rounds-and-cleanup/`: 회원 배치 화면 및 `sanitized-outcomes.json`의 경기 식별자/3인 화면·저장API 일치, `member-api-checks.json`의 전적·권한·로그아웃 확인.
- 두 번째 회원 결과 이미지를 직접 열어 3인 기록과 XP 표시를 확인했다. 토큰/원본 WS/인증 화면 trace는 보관하지 않는다.

## 미검증 및 환경 차이

Azure PostgreSQL 직접 대조, 관리자 로그인·조작, MFA/암호 변경·재설정·탈퇴, 실제 휴대폰, 고지연망·부하·장애는 미실행이다. 관리자 암호를 추측하거나 초기화하지 않았다. TestMap1의 제한된 경기로 모든 맵/스킬/규칙 조합을 보장하지 않는다. CI는 Azure에 접근하지 않으며 로컬 수정은 아직 Azure에 배포되지 않았다.

## 관리자 읽기 전용 배치

소유자가 제공한 현재 자격으로 정상 로그인201을 확인했다. 실제 관리자 UI에서 서버 개요·등록 worker 표시·자동 갱신 중지·이번에 만든 회원A의 닉네임 조회가 통과했다. 최초 조회 검사는 닉네임 옆 계정 번호를 누락한 exact locator라 timeout했고, 실제 표시 전체를 검사하도록 수정한 재실행이 통과했다. 기존 사용자 조회/제재/설정 변경을 수행하지 않았다. 서버 감사 목록에 다른 기록이 표시될 수 있어 화면·응답 본문을 저장하지 않고 성공 boolean과 요청 개수만 `admin-readonly.json`에 남겼다. 관리자 비밀번호 임시 파일은 실행 후 삭제했다.

따라서 앞 절의 관리자 미실행 항목 중 로그인·개요·테스트 계정 조회는 이 결과로 갱신한다. 관리자 신고 처리·제재·공지/점검 변경의 Azure 실행은 여전히 미실행이다.

## HTTPS 헤더 확인과 보강

공개 readiness와 HTML 문서를 각1회씩 조회했다. 기본 OS 인증서 검증을 통과했고 모두200이었다. readiness 한 번의 응답은369ms였다(성능 기준/부하 검증 아님). 두 응답에 HSTS/CSP/X-Content-Type-Options/X-Frame-Options/Referrer-Policy가 없음을 기록했다. 이를 XSS나 clickjacking 악용 성공으로 표현하지 않는다.

로컬 Caddy 구성에 HSTS1년(하위도메인 포함 안 함), nosniff, frame DENY, strict-origin referrer 및 제한적인 frame-ancestors/base-uri/object-src CSP를 추가했다. script-src nonce/해시 CSP는 별도 미구현이다. Azure에는 미배포이며 승인 후 해당 응답 헤더 및 전체 사용자 여정을 다시 확인해야 한다. 증거는 `https-readiness.json`과 `https-document-headers.json`이다.
