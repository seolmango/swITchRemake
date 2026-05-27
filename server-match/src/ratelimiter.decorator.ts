import { SetMetadata } from '@nestjs/common';

export interface RateLimitOptions {
    anon: number;
    user: number;
    ttl: number;
}

export const RATE_LIMIT_KEY = 'rateLimit';

export const RateLimiter = (options: RateLimitOptions): MethodDecorator => {
    return SetMetadata(RATE_LIMIT_KEY, options);
}