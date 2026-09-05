import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from "./database/database.module";
import { RedisModule } from "./redis/redis.module";
import { EmailModule } from "./email/email.module";
import { AuthModule } from "./auth/auth.module";
import { UserModule } from "./user/user.module";
import * as path from 'path';
import { APP_GUARD } from "@nestjs/core";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { PreAuthIpRateLimiterGuard, RateLimiterGuard } from "./ratelimiter.guard";
import { HealthModule } from './health/health.module';
import { SessionModule } from './session/session.module';
import { SanctionModule } from './sanction/sanction.module';
import { RoomsModule } from './rooms/rooms.module';
import { ResultsModule } from './results/results.module';
import { MatchesModule } from './matches/matches.module';
import { AdminModule } from './admin/admin.module';
import { ReportsModule } from './reports/reports.module';
import { RetentionModule } from './retention/retention.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { MaintenanceGuard } from './maintenance/maintenance.guard';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            // The DI smoke test assembles this module without loading the
            // repository's secret-bearing .env file.
            ignoreEnvFile: process.env.SWITCH_SKIP_ENV_FILE === 'true',
            envFilePath: path.resolve(__dirname, '../../.env'),
        }),
        DatabaseModule,
        RedisModule,
        MaintenanceModule,
        EmailModule,
        AuthModule,
        UserModule,
        SessionModule,
        SanctionModule,
        RoomsModule,
        ResultsModule,
        MatchesModule,
        AdminModule,
        ReportsModule,
        RetentionModule,
        HealthModule,
    ],
    controllers: [],
    providers: [
        {
            provide: APP_GUARD,
            useClass: PreAuthIpRateLimiterGuard,
        },
        {
            provide: APP_GUARD,
            useClass: JwtAuthGuard,
        },
        {
            provide: APP_GUARD,
            useClass: RateLimiterGuard,
        },
        {
            provide: APP_GUARD,
            useClass: MaintenanceGuard,
        },
    ],
})
export class AppModule {}
