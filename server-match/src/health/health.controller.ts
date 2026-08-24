import { Controller, Get } from '@nestjs/common';
import { EmailService } from '../email/email.service';
import { RateLimiter } from '../ratelimiter.decorator';

@Controller('health')
export class HealthController {
    constructor(private readonly emailService: EmailService) {}

    @Get()
    @RateLimiter({ anon: 120, guest: 120, account: 120, ttl: 60000 })
    check() {
        return {
            status: 'ok' as const,
            timestamp: Date.now(),
            email: this.emailService.getHealthStatus(),
        };
    }
}
