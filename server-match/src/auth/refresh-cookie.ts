import type { ConfigService } from '@nestjs/config';

/**
 * refresh 토큰 쿠키의 속성. 발급·삭제하는 모든 곳이 이 함수를 쓴다.
 *
 * 세 컨트롤러가 각자 같은 객체를 적고 있었고, `clearCookie`에 넘기는 값이 발급할 때와 달라서
 * 브라우저가 지우지 못하는 경우가 생겼다. 삭제는 이름·경로·도메인이 발급 때와 같아야 한다.
 *
 * `secure`는 `APP_ENV`로 판단한다. 예전에는 `NODE_ENV`를 봤는데, 이 저장소에서 운영을 가르는
 * 값은 전부 `APP_ENV`이고 `.env.example`에 `NODE_ENV`는 아예 없다. 문서대로 배포하면 2주짜리
 * 세션 쿠키가 Secure 없이 나갔다.
 */
export function refreshCookieOptions(config: ConfigService) {
    return {
        httpOnly: true,
        secure: config.get<string>('APP_ENV') === 'prod',
        sameSite: 'strict' as const,
        maxAge: Number(config.get('JWT_REFRESH_EXPIRATION')),
        path: '/',
        signed: true,
    };
}
