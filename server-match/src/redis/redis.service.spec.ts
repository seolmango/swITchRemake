import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { RedisService } from './redis.service';

class FakeRedisConnection {
    readonly calls: string[] = [];
    readonly duplicates: FakeRedisConnection[] = [];
    disconnected = false;

    on(_event: string, _listener: (...args: unknown[]) => void): this { return this; }
    duplicate(): Redis {
        const duplicate = new FakeRedisConnection();
        this.duplicates.push(duplicate);
        return duplicate as unknown as Redis;
    }
    async get(_key: string): Promise<null> { this.calls.push('get'); return null; }
    async xreadgroup(..._args: unknown[]): Promise<null> { this.calls.push('xreadgroup'); return null; }
    disconnect(): void { this.disconnected = true; }
}

function serviceWith(primary: FakeRedisConnection): RedisService {
    const service = new RedisService({} as ConfigService);
    (service as unknown as { client: Redis }).client = primary as unknown as Redis;
    return service;
}

test('blocking stream readers use dedicated connections while regular commands stay on the primary connection', async () => {
    const primary = new FakeRedisConnection();
    const service = serviceWith(primary);

    await Promise.all([
        service.readGroup('results', 'results-group', 'results-consumer', 1_000),
        service.readGroup('replies', 'replies-group', 'replies-consumer', 1_000),
        service.get('room:1'),
    ]);

    assert.deepEqual(primary.calls, ['get']);
    assert.equal(primary.duplicates.length, 2);
    assert.deepEqual(primary.duplicates.map((client) => client.calls), [['xreadgroup'], ['xreadgroup']]);
});

test('disconnects every dedicated blocking connection during module shutdown', async () => {
    const primary = new FakeRedisConnection();
    const service = serviceWith(primary);
    await service.readGroup('results', 'results-group', 'results-consumer', 1_000);
    await service.readGroup('replies', 'replies-group', 'replies-consumer', 1_000);

    service.onModuleDestroy();

    assert.equal(primary.disconnected, true);
    assert.deepEqual(primary.duplicates.map((client) => client.disconnected), [true, true]);
});
