import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
    private client!: Redis;
    private readonly logger = new Logger(RedisService.name);

    constructor(private configService: ConfigService) {}

    onModuleInit() {
        this.client = new Redis({
            host: this.configService.get<string>('REDIS_HOST', 'localhost'),
            port: this.configService.get<number>('REDIS_PORT', 6379),
        });

        this.client.on('connect', () => {
            this.logger.log('Redis Connection Success');
        });

        this.client.on('error', (err) => {
            this.logger.error('Redis Connection Failed', err);
        });
    }

    onModuleDestroy() {
        this.client.disconnect();
    }

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
        if (ttlSeconds) {
            await this.client.set(key, value, 'EX', ttlSeconds);
        } else {
            await this.client.set(key, value);
        }
    }

    async get(key: string): Promise<string | null> {
        return await this.client.get(key);
    }

    async del(key: string): Promise<void> {
        await this.client.del(key);
    }
}