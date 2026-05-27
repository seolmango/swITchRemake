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

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            envFilePath: path.resolve(__dirname, '../../.env'),
        }),
        ThrottlerModule.forRoot([{ttl: 60000, limit: 0}]),
        DatabaseModule,
        RedisModule,
        EmailModule,
        AuthModule,
        UserModule,
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