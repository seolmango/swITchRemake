import { SetMetadata } from '@nestjs/common';

export interface RateLimitOptions {
    /** 한 기능의 신원 한도. 로그인 여부나 신원 종류로 갈라 쓰지 않는다. */
    limit: number;
    ttl: number;
}

export const RATE_LIMIT_KEY = 'rateLimit';

export const RateLimiter = (options: RateLimitOptions): MethodDecorator => {
    return SetMetadata(RATE_LIMIT_KEY, options);
}
