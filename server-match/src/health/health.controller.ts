import { Controller, Get } from '@nestjs/common';
import { RateLimiter } from '../ratelimiter.decorator';

@Controller('health')
export class HealthController {
    @Get()
    @RateLimiter({ anon: 120, user: 120, ttl: 60000 })
    check() {
        return {
            status: 'ok' as const,
            timestamp: Date.now(),
        };
    }
}
