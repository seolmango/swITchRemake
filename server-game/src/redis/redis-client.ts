import Redis, { type RedisOptions } from 'ioredis';

export interface StreamEntry {
    readonly id: string;
    readonly fields: Readonly<Record<string, string>>;
}

/** 테스트와 실제 Redis가 함께 구현하는 최소 control-plane 명령 집합. */
export interface RedisPort {
    connect(): Promise<void>;
    close(): Promise<void>;
    isReady(): boolean;
    get(key: string): Promise<string | null>;
    setPx(key: string, value: string, ttlMs: number): Promise<void>;
    setPxIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
    delete(key: string): Promise<void>;
    compareAndDelete(key: string, expectedValue: string): Promise<boolean>;
    compareAndExpire(key: string, expectedValue: string, ttlMs: number): Promise<boolean>;
    zAdd(key: string, score: number, member: string): Promise<void>;
    zRemove(key: string, member: string): Promise<void>;
    /** 정렬셋 멤버를 점수 오름차순으로. 재우는 서버가 방을 넘길 상대를 찾는 데 쓴다. */
    zRange(key: string, start: number, stop: number): Promise<string[]>;
    zRemoveByScore(key: string, min: number, max: number): Promise<number>;
    xGroupCreate(stream: string, group: string, startId: string): Promise<void>;
    xReadGroup(stream: string, group: string, consumer: string, blockMs: number, count: number): Promise<StreamEntry[]>;
    xAutoClaim(stream: string, group: string, consumer: string, minIdleMs: number, count: number): Promise<StreamEntry[]>;
    xAdd(stream: string, field: string, value: string, maxLength: number): Promise<string>;
    xAck(stream: string, group: string, entryId: string): Promise<void>;
}

export interface RedisClientOptions {
    readonly host: string;
    readonly port: number;
    readonly password: string;
    readonly logger?: (level: 'info' | 'error', message: string, error?: unknown) => void;
    /** Test seam; production clients are created by ioredis directly. */
    readonly createClient?: (options: RedisOptions) => Redis;
}

function fields(raw: readonly string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (let index = 0; index < raw.length; index += 2) {
        const key = raw[index];
        const value = raw[index + 1];
        if (key !== undefined && value !== undefined) result[key] = value;
    }
    return result;
}

function streamEntries(response: unknown): StreamEntry[] {
    if (!Array.isArray(response)) return [];
    const entries: StreamEntry[] = [];
    for (const stream of response) {
        if (!Array.isArray(stream) || !Array.isArray(stream[1])) continue;
        for (const message of stream[1] as unknown[]) {
            if (!Array.isArray(message) || typeof message[0] !== 'string' || !Array.isArray(message[1])) continue;
            entries.push({ id: message[0], fields: fields(message[1] as string[]) });
        }
    }
    return entries;
}

/** ioredis 연결 생명주기. offline queue를 끄므로 장애 중 명령이 무한히 쌓이지 않는다. */
export class RedisClient implements RedisPort {
    readonly #client: Redis;
    readonly #blockingClients = new Map<string, Redis>();
    readonly #logger: NonNullable<RedisClientOptions['logger']>;
    #ready = false;

    public constructor(options: RedisClientOptions) {
        this.#logger = options.logger ?? (() => undefined);
        const clientOptions = {
            host: options.host,
            port: options.port,
            ...(options.password === '' ? {} : { password: options.password }),
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
        };
        this.#client = options.createClient?.(clientOptions) ?? new Redis(clientOptions);
        this.#client.on('ready', () => {
            this.#ready = true;
            this.#logger('info', 'Redis connection ready');
        });
        this.#client.on('close', () => { this.#ready = false; });
        this.#client.on('end', () => { this.#ready = false; });
        this.#client.on('error', (error: unknown) => {
            this.#ready = false;
            this.#logger('error', 'Redis connection error', error);
        });
    }

    public async connect(): Promise<void> {
        if (this.#client.status === 'ready') {
            this.#ready = true;
            return;
        }
        if (this.#client.status === 'wait' || this.#client.status === 'end') await this.#client.connect();
    }

    public async close(): Promise<void> {
        this.#ready = false;
        for (const client of this.#blockingClients.values()) client.disconnect();
        this.#blockingClients.clear();
        if (this.#client.status === 'end') return;
        try {
            await this.#client.quit();
        } catch {
            this.#client.disconnect();
        }
    }

    public isReady(): boolean { return this.#ready && this.#client.status === 'ready'; }

    public async get(key: string): Promise<string | null> { return this.#client.get(key); }

    public async setPx(key: string, value: string, ttlMs: number): Promise<void> {
        await this.#client.set(key, value, 'PX', ttlMs);
    }

    public async setPxIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
        return (await this.#client.set(key, value, 'PX', ttlMs, 'NX')) === 'OK';
    }

    public async delete(key: string): Promise<void> { await this.#client.del(key); }

    public async compareAndDelete(key: string, expectedValue: string): Promise<boolean> {
        const result = await this.#client.eval(
            'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
            1,
            key,
            expectedValue,
        );
        return result === 1;
    }

    public async compareAndExpire(key: string, expectedValue: string, ttlMs: number): Promise<boolean> {
        const result = await this.#client.eval(
            'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end',
            1,
            key,
            expectedValue,
            ttlMs,
        );
        return result === 1;
    }

    public async zAdd(key: string, score: number, member: string): Promise<void> {
        await this.#client.zadd(key, score, member);
    }

    public async zRemove(key: string, member: string): Promise<void> { await this.#client.zrem(key, member); }

    public async zRange(key: string, start: number, stop: number): Promise<string[]> {
        return this.#client.zrange(key, start, stop);
    }

    public async zRemoveByScore(key: string, min: number, max: number): Promise<number> {
        return this.#client.zremrangebyscore(key, min, max);
    }

    public async xGroupCreate(stream: string, group: string, startId: string): Promise<void> {
        try {
            await this.#client.xgroup('CREATE', stream, group, startId, 'MKSTREAM');
        } catch (error: unknown) {
            if (!String(error instanceof Error ? error.message : error).includes('BUSYGROUP')) throw error;
        }
    }

    public async xReadGroup(
        stream: string,
        group: string,
        consumer: string,
        blockMs: number,
        count: number,
    ): Promise<StreamEntry[]> {
        const response = await this.#blockingClient(stream, group, consumer).xreadgroup(
            'GROUP', group, consumer,
            'COUNT', count,
            'BLOCK', blockMs,
            'STREAMS', stream, '>',
        );
        return streamEntries(response);
    }

    #blockingClient(stream: string, group: string, consumer: string): Redis {
        const key = `${stream}\u0000${group}\u0000${consumer}`;
        let client = this.#blockingClients.get(key);
        if (client === undefined) {
            client = this.#client.duplicate();
            client.on('error', (error: unknown) => {
                this.#logger('error', 'Redis blocking connection error', error);
            });
            this.#blockingClients.set(key, client);
        }
        return client;
    }

    public async xAutoClaim(
        stream: string,
        group: string,
        consumer: string,
        minIdleMs: number,
        count: number,
    ): Promise<StreamEntry[]> {
        const response = await this.#client.xautoclaim(
            stream, group, consumer, minIdleMs, '0-0', 'COUNT', count,
        ) as unknown;
        if (!Array.isArray(response) || !Array.isArray(response[1])) return [];
        return streamEntries([[stream, response[1]]]);
    }

    public async xAdd(stream: string, field: string, value: string, maxLength: number): Promise<string> {
        const id = await this.#client.xadd(stream, 'MAXLEN', '~', maxLength, '*', field, value);
        if (id === null) throw new Error('Redis did not return a stream entry id');
        return id;
    }

    public async xAck(stream: string, group: string, entryId: string): Promise<void> {
        await this.#client.xack(stream, group, entryId);
    }
}
