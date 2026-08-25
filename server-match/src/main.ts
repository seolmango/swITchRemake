import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DRIZZLE } from './database/database.module';
import { sql } from 'drizzle-orm';
import fastifyCookie from '@fastify/cookie';
import { ConfigService } from '@nestjs/config';

/** 서명 키가 세 종류인 이유는 토큰 종류를 나누기 위해서다. 같은 값이면 나눈 적이 없는 것과 같다. */
const JWT_SECRET_KEYS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'JWT_GUEST_REFRESH_SECRET'] as const;
const MIN_JWT_SECRET_LENGTH = 32;

/**
 * 세 secret이 모두 있고, 서로 다르고, 충분히 긴지 부팅할 때 확인한다.
 *
 * 예전에는 `JWT_GUEST_REFRESH_SECRET`이 없으면 `JWT_REFRESH_SECRET`으로 조용히 대체됐다.
 * `.env.example`은 둘이 달라야 한다고 적어 두었는데 코드가 그 규칙을 무력화했고, 값을 빠뜨린
 * 배포는 아무 경고 없이 게스트 토큰과 계정 토큰을 같은 키로 서명했다.
 *
 * 여기서 죽는 것이 맞다. 인증 키가 틀린 채로 뜬 서버는 뜨지 않은 것보다 나쁘다.
 */
function assertDistinctJwtSecrets(config: ConfigService): void {
    const values = new Map<string, string>();
    for (const key of JWT_SECRET_KEYS) {
        const value = config.get<string>(key);
        if (typeof value !== 'string' || value.length < MIN_JWT_SECRET_LENGTH) {
            throw new Error(`${key} must be set to at least ${MIN_JWT_SECRET_LENGTH} characters. 예: openssl rand -base64 48`);
        }
        const duplicate = values.get(value);
        if (duplicate !== undefined) throw new Error(`${key} must differ from ${duplicate}`);
        values.set(value, key);
    }
}

async function bootstrap() {
    const app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        new FastifyAdapter({ trustProxy: true })
    );
    const logger = new Logger('Bootstrap');

    app.useGlobalPipes(new ValidationPipe({ transform: true }));

    const configService = app.get(ConfigService);
    assertDistinctJwtSecrets(configService);
    const cookieSecret = configService.get<string>('JWT_REFRESH_SECRET');
    try {
        const db = app.get(DRIZZLE);
        await db.execute(sql`SELECT 1`);
        logger.log('PostgreSQL Connection Success');
    } catch (error) {
        logger.error('PostgreSQL Connection Failed', error);
    }

    await app.register(fastifyCookie, {
        secret: cookieSecret,
    });

    const port = process.env.PORT || 3000;
    await app.listen(port, '0.0.0.0');


    logger.log(`swITch Matching Server is running on: http://localhost:${port}`);
}

bootstrap();