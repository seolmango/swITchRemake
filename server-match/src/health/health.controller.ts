import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { EmailService } from '../email/email.service';
import { RateLimiter } from '../ratelimiter.decorator';
import { DRIZZLE } from '../database/database.module';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../database/schema';
import { sql } from 'drizzle-orm';
import { RedisService } from '../redis/redis.service';
import { MaintenanceService } from '../maintenance/maintenance.service';

@Controller('health')
export class HealthController {
    constructor(
        private readonly emailService: EmailService,
        @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
        private readonly redis: RedisService,
        private readonly maintenance: MaintenanceService,
    ) {}

    @Get(['', 'ready'])
    @RateLimiter({ limit: 120, ttl: 60000 })
    async readiness() {
        try {
            const state = await this.maintenance.getPublicState();
            if (state.status === 'maintenance') {
                return {
                    status: 'maintenance' as const,
                    timestamp: Date.now(),
                    returnsAt: state.returnsAt,
                    ...(state.notice ? { notice: state.notice } : {}),
                };
            }
            const [, redisReady] = await Promise.all([this.db.execute(sql`SELECT 1`), this.redis.ping()]);
            if (!redisReady) throw new Error('Redis did not answer PONG');
            const announcement = state.announcement;
            return {
                status: 'ready' as const,
                timestamp: Date.now(),
                email: this.emailService.getHealthStatus(),
                ...(announcement ? { announcement } : {}),
            };
        } catch {
            throw new ServiceUnavailableException({ status: 'not-ready', timestamp: Date.now() });
        }
    }

    @Get('live')
    @RateLimiter({ limit: 120, ttl: 60000 })
    liveness() {
        return { status: 'alive' as const, timestamp: Date.now() };
    }
}
