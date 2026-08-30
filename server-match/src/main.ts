import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DRIZZLE } from './database/database.module';
import { sql } from 'drizzle-orm';
import fastifyCookie from '@fastify/cookie';
import { ConfigService } from '@nestjs/config';
import { assertRateLimitPolicy } from './ratelimiter.guard';

/**
 * 프록시가 넣은 클라이언트 IP 헤더를 어디까지 믿을지 정한다.
 *
 * 예전에는 `trustProxy: true`였다. 그러면 **아무나** `X-Forwarded-For`를 적어 보낼 수 있고,
 * IP로 세는 모든 제한(로그인 시도, 인증 메일 발송, 게스트 발급, 방 생성)이 헤더 한 줄로
 * 무력해진다. 세션에 남는 IP 기록도 통째로 위조된다.
 *
 * 그래서 **프록시의 주소만** 신뢰한다. 비어 있으면 소켓 주소를 쓴다 — 앞에 무엇이 있는지
 * 모를 때는 안 믿는 쪽이 맞다. 리버스 프록시 뒤에 두고 이 값을 비워 두면 모든 요청이 프록시
 * 한 IP로 보이므로, 운영에서는 반드시 채워야 한다.
 */
function resolveTrustedProxies(): string[] | false {
    const raw = process.env.MATCH_TRUSTED_PROXIES?.trim();
    if (!raw) return false;
    const rules = raw.split(',').map((rule) => rule.trim()).filter((rule) => rule.length > 0);
    return rules.length > 0 ? rules : false;
}

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
        new FastifyAdapter({ trustProxy: resolveTrustedProxies() })
    );
    const logger = new Logger('Bootstrap');

    app.useGlobalPipes(new ValidationPipe({ transform: true }));

    const configService = app.get(ConfigService);
    assertDistinctJwtSecrets(configService);
    assertRateLimitPolicy(configService.get<string>('APP_ENV'));
    if (configService.get<string>('APP_ENV') === 'prod' && resolveTrustedProxies() === false) {
        logger.warn('MATCH_TRUSTED_PROXIES가 비어 있습니다. 리버스 프록시 뒤라면 모든 요청이 한 IP로 보여 IP 기반 제한이 사실상 전역이 됩니다.');
    }
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