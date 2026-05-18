import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from "./database/database.module";
import { RedisModule } from "./redis/redis.module";
import { EmailModule } from "./email/email.module";
import { AuthModule } from "./auth/auth.module";
import { UserModule } from "./user/user.module";
import * as path from 'path';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            envFilePath: path.resolve(__dirname, '../../.env'),
        }),
        DatabaseModule,
        RedisModule,
        EmailModule,
        AuthModule,
        UserModule,
    ],
    controllers: [],
    providers: [],
})
export class AppModule {}