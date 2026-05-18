import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export const DRIZZLE = 'DRIZZLE';

@Global()
@Module({
    providers: [
        {
            provide: DRIZZLE,
            useFactory: (configService: ConfigService) => {
                const user = configService.get<string>('DB_USER');
                const password = configService.get<string>('DB_PASSWORD');
                const host = configService.get<string>('DB_HOST');
                const port = configService.get<string>('DB_PORT');
                const dbName = configService.get<string>('DB_NAME');

                const connectionString = `postgres://${user}:${password}@${host}:${port}/${dbName}`;
                const client = postgres(connectionString);
                return drizzle(client, { schema });
            },
            inject: [ConfigService],
        },
    ],
    exports: [DRIZZLE],
})
export class DatabaseModule {}