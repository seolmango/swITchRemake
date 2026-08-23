import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export interface StreamEntry {
    id: string;
    fields: Record<string, string>;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
    private client!: Redis;
    private readonly logger = new Logger(RedisService.name);

    constructor(private configService: ConfigService) {}

    onModuleInit() {
        this.client = new Redis({
            host: this.configService.get<string>('REDIS_HOST', 'localhost'),
            port: this.configService.get<number>('REDIS_PORT', 6379),
            password: this.configService.get<string>('REDIS_PASSWORD'),
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

    async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
        const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
        return result === 'OK';
    }

    async compareAndDelete(key: string, expectedValue: string): Promise<boolean> {
        const result = await this.client.eval(
            'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
            1,
            key,
            expectedValue,
        );
        return result === 1;
    }

    async compareAndSetWithTtl(
        key: string,
        expectedValue: string,
        value: string,
        ttlSeconds: number,
    ): Promise<boolean> {
        const result = await this.client.eval(
            'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3]) else return nil end',
            1,
            key,
            expectedValue,
            value,
            String(ttlSeconds),
        );
        return result === 'OK';
    }

    async ttlMilliseconds(key: string): Promise<number> {
        return this.client.pttl(key);
    }

    async incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
        const result = await this.client.eval(
            'local n = redis.call("INCR", KEYS[1]); if n == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end; return n',
            1,
            key,
            String(ttlSeconds),
        );
        return Number(result);
    }

    async sortedSetMembers(key: string, start: number, stop: number): Promise<string[]> {
        return this.client.zrange(key, start, stop);
    }

    async addStreamEntry(
        stream: string,
        field: string,
        value: string,
        maxLength = 10_000,
    ): Promise<string> {
        const id = await this.client.xadd(stream, 'MAXLEN', '~', maxLength, '*', field, value);
        if (!id) {
            throw new Error('Redis did not return a stream entry id');
        }
        return id;
    }

    async ensureConsumerGroup(stream: string, group: string, startId = '$'): Promise<void> {
        try {
            await this.client.xgroup('CREATE', stream, group, startId, 'MKSTREAM');
        } catch (error: any) {
            if (!String(error?.message).includes('BUSYGROUP')) {
                throw error;
            }
        }
    }

    async readGroup(
        stream: string,
        group: string,
        consumer: string,
        blockMilliseconds: number,
        count = 10,
    ): Promise<StreamEntry[]> {
        const response = await this.client.xreadgroup(
            'GROUP', group, consumer,
            'COUNT', count,
            'BLOCK', blockMilliseconds,
            'STREAMS', stream, '>',
        );
        if (!response) {
            return [];
        }

        const entries: StreamEntry[] = [];
        for (const [, messages] of response as Array<[string, Array<[string, string[]]>]>) {
            for (const [id, rawFields] of messages) {
                const fields: Record<string, string> = {};
                for (let index = 0; index < rawFields.length; index += 2) {
                    fields[rawFields[index]] = rawFields[index + 1];
                }
                entries.push({ id, fields });
            }
        }
        return entries;
    }

    async autoClaim(
        stream: string,
        group: string,
        consumer: string,
        minIdleMilliseconds: number,
        count = 10,
    ): Promise<StreamEntry[]> {
        const response = await this.client.xautoclaim(
            stream,
            group,
            consumer,
            minIdleMilliseconds,
            '0-0',
            'COUNT',
            count,
        ) as unknown as [string, Array<[string, string[]]>];
        const messages = response?.[1] ?? [];
        return messages.map(([id, rawFields]) => {
            const fields: Record<string, string> = {};
            for (let index = 0; index < rawFields.length; index += 2) {
                fields[rawFields[index]] = rawFields[index + 1];
            }
            return { id, fields };
        });
    }

    async acknowledge(stream: string, group: string, entryId: string): Promise<void> {
        await this.client.xack(stream, group, entryId);
    }
}
