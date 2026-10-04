import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { databaseConnectionOptions } from './connection-options';
import * as schema from './schema';

export const DRIZZLE = 'DRIZZLE';

@Global()
@Module({
    providers: [
        {
            provide: DRIZZLE,
            useFactory: (configService: ConfigService) => {
                const client = postgres(databaseConnectionOptions(
                    (name) => configService.get<string>(name),
                ));
                return drizzle(client, { schema });
            },
            inject: [ConfigService],
        },
    ],
    exports: [DRIZZLE],
})
export class DatabaseModule {}
