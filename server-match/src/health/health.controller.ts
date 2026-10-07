import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { EmailService } from '../email/email.service';
import { RateLimiter } from '../ratelimiter.decorator';
import { DRIZZLE } from '../database/database.module';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../database/schema';
import { sql } from 'drizzle-orm';
import { RedisService } from '../redis/redis.service';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { makeKeys, type GameServerHeartbeat } from 'shared';

/** 같은 값을 매 요청 Redis에서 읽지 않는다. 클라이언트는 10초마다 묻는다. */
const VERSION_CACHE_MS = 10_000;

@Controller('health')
export class HealthController {
    private readonly keys = makeKeys(process.env.APP_ENV ?? 'dev');
    private versionCache: { at: number; rulesVersions: string[] } | null = null;

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
            const rulesVersions = await this.liveRulesVersions();
            return {
                status: 'ready' as const,
                timestamp: Date.now(),
                email: this.emailService.getHealthStatus(),
                ...(announcement ? { announcement } : {}),
                ...(rulesVersions.length > 0 ? { rulesVersions } : {}),
            };
        } catch {
            throw new ServiceUnavailableException({ status: 'not-ready', timestamp: Date.now() });
        }
    }

    /**
     * 지금 살아 있는 인게임 서버들의 규칙(밸런스) 버전. 타이틀 화면이 "지금 서버는 몇 패치인가"로 보여 준다.
     * 배포 중에는 둘이 섞일 수 있어 목록이다. 읽지 못하면 빈 목록 — 버전 표시가 health를 실패시키지 않는다.
     */
    private async liveRulesVersions(): Promise<string[]> {
        const now = Date.now();
        if (this.versionCache && now - this.versionCache.at < VERSION_CACHE_MS) return this.versionCache.rulesVersions;
        let rulesVersions: string[] = [];
        try {
            const ids = await this.redis.sortedSetMembers(this.keys.gameServersAlive(), 0, -1);
            const servers = await Promise.all(ids.map(async (id) => {
                const raw = await this.redis.get(this.keys.gameServer(id));
                return raw ? JSON.parse(raw) as Partial<GameServerHeartbeat> : null;
            }));
            rulesVersions = [...new Set(servers
                .filter((server) => server && !server.draining && typeof server.rulesVersion === 'string')
                .map((server) => server!.rulesVersion as string))].sort();
        } catch {
            rulesVersions = [];
        }
        this.versionCache = { at: now, rulesVersions };
        return rulesVersions;
    }

    @Get('live')
    @RateLimiter({ limit: 120, ttl: 60000 })
    liveness() {
        return { status: 'alive' as const, timestamp: Date.now() };
    }
}
