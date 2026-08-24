import assert from 'node:assert/strict';
import test from 'node:test';
import type Redis from 'ioredis';
import { RedisClient } from './redis-client';

class FakeRedisConnection {
    status: 'ready' | 'end' = 'ready';
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
    async quit(): Promise<void> { this.status = 'end'; }
    disconnect(): void { this.disconnected = true; this.status = 'end'; }
}

function clientWith(primary: FakeRedisConnection): RedisClient {
    return new RedisClient({
        host: 'localhost',
        port: 6379,
        password: '',
        createClient: () => primary as unknown as Redis,
    });
}

test('command stream blocking reads use a dedicated connection while registry commands use the primary connection', async () => {
    const primary = new FakeRedisConnection();
    const client = clientWith(primary);

    await Promise.all([
        client.xReadGroup('commands:game-1', 'commands-group', 'game-1', 1_000, 10),
        client.get('game-server:game-1'),
    ]);

    assert.deepEqual(primary.calls, ['get']);
    assert.equal(primary.duplicates.length, 1);
    assert.deepEqual(primary.duplicates[0]?.calls, ['xreadgroup']);
});

test('close disconnects the dedicated blocking connection', async () => {
    const primary = new FakeRedisConnection();
    const client = clientWith(primary);
    await client.xReadGroup('commands:game-1', 'commands-group', 'game-1', 1_000, 10);

    await client.close();

    assert.equal(primary.disconnected, false);
    assert.equal(primary.duplicates[0]?.disconnected, true);
});
