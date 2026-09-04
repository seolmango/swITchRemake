import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { EmailService } from '../email/email.service';
import { RateLimiter } from '../ratelimiter.decorator';
import { DRIZZLE } from '../database/database.module';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../database/schema';
import { sql } from 'drizzle-orm';
import { RedisService } from '../redis/redis.service';

@Controller('health')
export class HealthController {
    constructor(
        private readonly emailService: EmailService,
        @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
        private readonly redis: RedisService,
    ) {}

    @Get(['', 'ready'])
    @RateLimiter({ anon: 120, guest: 120, account: 120, ttl: 60000 })
    async readiness() {
        try {
            const [, redisReady] = await Promise.all([this.db.execute(sql`SELECT 1`), this.redis.ping()]);
            if (!redisReady) throw new Error('Redis did not answer PONG');
        } catch {
            throw new ServiceUnavailableException({ status: 'not-ready', timestamp: Date.now() });
        }
        return {
            status: 'ready' as const,
            timestamp: Date.now(),
            email: this.emailService.getHealthStatus(),
        };
    }

    @Get('live')
    @RateLimiter({ anon: 120, guest: 120, account: 120, ttl: 60000 })
    liveness() {
        return { status: 'alive' as const, timestamp: Date.now() };
    }
}
