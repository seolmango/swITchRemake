import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DRIZZLE } from './database/database.module';
import { sql } from 'drizzle-orm';

async function bootstrap() {
    const app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        new FastifyAdapter()
    );
    const logger = new Logger('Bootstrap');

    app.useGlobalPipes(new ValidationPipe({ transform: true }));

    try {
        const db = app.get(DRIZZLE);
        await db.execute(sql`SELECT 1`);
        logger.log('PostgreSQL Connection Success');
    } catch (error) {
        logger.error('PostgreSQL Connection Failed', error);
    }

    const port = process.env.PORT || 3000;
    await app.listen(port, '0.0.0.0');

    logger.log(`swITch Matching Server is running on: http://localhost:${port}`);
}

bootstrap();