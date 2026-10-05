# 보안 유형별 증거 범위

이 표는 취약점이 없다는 판정이 아니다. 실제 성공·거부, 계층 회귀, 소스 검토만 한 항목을 분리한다. 정상 회원·게스트·관리자와 전체 경기의 성공 증거는 [로컬 결과](local-results.md), [Azure 결과](azure-results.md)와 연결한다.

| 유형 | 현재 근거 | 판정 범위와 남은 검증 |
|---|---|---|
| 인증·BOLA·역할 | 실제 회원 자기 결과/리플레이 허용, 타 회원 거부; 일반 회원 관리자403; 타인 세션 삭제404; 실제 관리자 조회/처리 성공 | 핵심 실제 경로 통과. 모든 관리자 변경의 조합까지 전수 검증한 것은 아님 |
| 세션·갱신·폐기 | 독립 탭의 동시 갱신, grace 뒤 옛 쿠키 재사용 폐기, 로그아웃 후 접근 거부; 계정 확장의 암호 변경/다른 기기 폐기 단계 | 실제 핵심 및 이메일/TOTP MFA·탈퇴 확장4/4 통과. 실패한 로그아웃의 계정·DB·새 탭 신원 보존 및 재시도 폐기도 최종 core 통과 |
| CSRF·CORS | refresh/trusted-device 쿠키는 HttpOnly/SameSite=Strict, prod에서 Secure; 보호된 변경은 인증된 actor 사용. match main에 임의 origin CORS 허용 설정 없음 | 소스 및 세션 회귀. 별도 공격 origin의 실제 브라우저 CSRF 전수 검증과 운영 Secure 쿠키 전달은 미검증 |
| WebSocket Origin·메시지 권한 | 실제 정상 Origin/ticket/map/ping 성공 후 다른 Origin, 재사용 ticket, 다른 신원의 resume, 잘못된 JSON/binary 거부. role/state는 room 계층 회귀 | 핵심 실제 및 계층 통과. 모든 연결 경계는 아님; 신규 worker 연결502는 S8로 수정했고 실제 증설·첫 연결·경기 저장을 재검증 |
| XSS·템플릿 | client의 raw HTML/eval/new Function sink 검색에서 직접 일치 없음. 공통 Markdown은 React text node와 http(s)/mailto 링크로 구성. 이름 등 사용자 문자열을 React로 렌더 | 소스 검토. 저장형/DOM XSS를 모든 입력에서 실제 재현한 검사는 아님. CSP 제한 보강의 배포 여부는 별도 Azure 결과 참조 |
| SQL 주입·과도한 필드 | Drizzle 파라미터 쿼리와 전역 whitelist/forbidNonWhitelisted validation; 실제 결과 저장과 잘못된 권한/DTO 회귀 | 소스 및 계층 검토. 모든 검색/filter 입력의 능동 주입 검증은 미실행 |
| 명령 주입·SSRF·리다이렉트 | 공개 입력에서 shell 실행 연결을 찾지 못함. gateway는 exact server route와 별도 내부 주소 allowlist/schema를 사용. 인앱 브라우저 이동은 현재 URL에서 생성 | 소스 및 gateway 회귀. 클라우드 메타데이터/운영 내부망 공격은 하지 않음. 아직 공개 공격 경로로 입증된 발견 아님 |
| 경로 이동·파일·리플레이 | LocalReplayStore 키는 제한된 파일명 규칙, gateway path 정규화/허용 prefix, 실제 서명 파일 생성/다운로드/재생과 bounded parser 검사 | 정상 파일과 제한된 비정상 입력 범위. 압축 폭탄/대형 파일·모든 손상 조합은 미실행 |
| 게임 신뢰·재전송·규칙 | 별도 actor/room binding, 6바이트 versioned 입력, wrap-aware sequence, 서버 권위 simulation; 실제3명 이동/종료/결과/DB/XP 일치 | 실제 두 경기와 규칙 계층 통과. 모든 맵·스킬·동시 조합은 미검증 |
| 트랜잭션·멱등성·부분 실패 | 실제 PostgreSQL 동시 result 단일 반영, issued authority, 중복 stats 불변, 후속 grant 이관. Redis/DB/write 장애 후 정상 복구 | 확인된 범위 통과. 메모리 outbox crash durability 및 방 이동의 원자적 소유권 확정은 미해결 설계 위험 |
| 자원·가용성 | 실제 Redis 장애의 fail-closed503/복구, OS PID 유지, 시간/CPU/메모리/pids 상한, 작은 seed 기반 parser 검사 | 무한 부하 없음. 실제 CPU·메모리·디스크 고갈/패킷 손실은 미실행. 동적 scale 1→2→1 및 정상 Redis에서 오래된 heartbeat의 실제 OS child 상한/복구도 별도 통과 |
| 비밀·의존성·배포·CI | tracked secret scanner, production dependency audit, pinned install/images/actions, read-only workflow token, internal runtime network, 자격 증명 상속 거부, sanitized artifact 검사 | 실제 core Actions 통과. 별도 컨테이너 OS CVE 전수 스캔, Azure 설정/성능 전반 보장은 아님 |

일회성 Azure에서는 위 표의 공격성 검사를 반복하지 않았다. 새 테스트 신원과 자기 데이터의 정상 처리·소수 권한 거부, HTTPS 및 운영 상태 조회만 수행했다.
