# 의존성 검토 — 2026-10-04

최초 npm audit --omit=dev 경고: @nestjs/platform-fastify, fastify, fast-uri, nodemailer 고위험 영향 경로. 실제 swITch 인증 우회나 Azure DoS를 재현했다는 뜻은 아니다. Azure에 공격 입력을 보내지 않았다.

## 영향 평가
- Nest path middleware 우회: 현재 앱 인증은 전역/메서드 guard, DTO validation은 global pipe. path-scoped MiddlewareConsumer 인증 구현은 발견하지 못했다. 프록시가 raw target을 정규화하기도 하므로 advisory를 곧바로 서비스 인증 우회로 단정하지 않음.
- Fastify malformed URL/not-found와 schema/HTTP2 관련 경고: 현재 앱 Nest guard 사용, HTTP2는 public TLS Caddy에서 종료하고 match는 HTTP1, explicit per-route Fastify schema 사용은 관찰하지 못함. 조건부 도달 가능성으로 분류하고 프레임워크를 패치.
- Nodemailer: 일반 사용자 email은 DTO IsEmail 검증, 메시지 HTML/제목은 서버 template. 임의 recipient 배열/자유형 주소/resolveContent 기능은 API로 받지 않음. 그럼에도 주소 parser와 SMTP 라이브러리 패치 필요. 대용량 입력 Azure 재현 금지.
- fast-uri: 프록시 upstream 목적지는 별도 allowlist. 경고를 SSRF 성공으로 세지 않음.

## 조치
@nestjs/platform-fastify 11.2.7, Nodemailer 10.0.14, Fastify 5.12.5 명시 override, 관련 fast-uri/개발 의존성의 호환 보안 업데이트. Nest major 11 유지. npm workspace override가 기존 lock에 적용되지 않아 독립 resolver로 계산한 Fastify/process-warning 기록을 선택 적용했고 npm11.21.0 ci --dry-run으로 실제 설치 계획 및 동기화 검증. npm11.21.0 audit --omit=dev 결과 **0 vulnerabilities**. 실제 Docker clean install+통합시험은 별도 실행표에 기록.

새 의존성 전부 최신화한 것이 아니다. Drizzle 도구 체인의 esbuild 관련 moderate는 전체 audit에 남을 수 있다. 개발 웹서버를 띄우지 않는 migration CLI만 internal network에서 실행하며, runtime prod dependency scan과 개발 dependency 잔여 위험을 구분한다.

## 공식 근거
- https://github.com/advisories/GHSA-9c5c-9qcx-q35q
- https://github.com/advisories/GHSA-p68q-wchp-6fh7
- https://github.com/advisories/GHSA-v53p-9fqp-m79j
- https://github.com/npm/cli/issues/9659

기존 공개 advisory를 검토·패치하는 변경이며 새로운 미패치 서비스 공격 절차는 공개하지 않는다. Azure는 배포 승인 전 기존 이미지이고 이 로컬 패치를 적용하지 않았다.
