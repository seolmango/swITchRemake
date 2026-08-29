import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from "./database/database.module";
import { RedisModule } from "./redis/redis.module";
import { EmailModule } from "./email/email.module";
import { AuthModule } from "./auth/auth.module";
import { UserModule } from "./user/user.module";
import * as path from 'path';
import { ThrottlerModule } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { RateLimiterGuard } from "./ratelimiter.guard";
import { HealthModule } from './health/health.module';
import { SessionModule } from './session/session.module';
import { SanctionModule } from './sanction/sanction.module';
import { RoomsModule } from './rooms/rooms.module';
import { ResultsModule } from './results/results.module';
import { MatchesModule } from './matches/matches.module';
import { AdminModule } from './admin/admin.module';
import { ReportsModule } from './reports/reports.module';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            // The DI smoke test assembles this module without loading the
            // repository's secret-bearing .env file.
            ignoreEnvFile: process.env.SWITCH_SKIP_ENV_FILE === 'true',
            envFilePath: path.resolve(__dirname, '../../.env'),
        }),
        ThrottlerModule.forRoot([{ttl: 60000, limit: 0}]),
        DatabaseModule,
        RedisModule,
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
        HealthModule,
    ],
    controllers: [],
    providers: [
        {
            provide: APP_GUARD,
            useClass: JwtAuthGuard,
        },
        {
            provide: APP_GUARD,
            useClass: RateLimiterGuard,
        }
    ],
})
export class AppModule {}
