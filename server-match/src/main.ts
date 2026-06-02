import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DRIZZLE } from './database/database.module';
import { sql } from 'drizzle-orm';
import fastifyCookie from '@fastify/cookie';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
    const app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        new FastifyAdapter({ trustProxy: true })
    );
    const logger = new Logger('Bootstrap');

    app.useGlobalPipes(new ValidationPipe({ transform: true }));

    const configService = app.get(ConfigService);
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