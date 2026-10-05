'use strict';

// Disposable local/audit Redis only. All keys use a unique disposable prefix.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { RedisClient } = require('../server-game/dist/redis/redis-client.js');

async function main() {
    const auditStack = process.env.AUDIT_STACK === 'true' && process.env.APP_ENV === 'audit'
        && process.env.REDIS_HOST === 'redis' && process.env.DB_HOST === 'postgres';
    if (!auditStack && (!process.env.REDIS_PORT || (process.env.REDIS_HOST && process.env.REDIS_HOST !== '127.0.0.1'))) {
        throw new Error('Set an explicit local REDIS_PORT, or use the disposable audit stack');
    }
    const redis = new RedisClient({ host: auditStack ? 'redis' : '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || '' });
    const prefix = `audit:atomic-handoff:${randomUUID()}:`;
    const keys = ['intent', 'room', 'actor1', 'actor2'].map(name => prefix + name);
    const values = ['pending', 'source', 'source', 'source'];
    const replacements = keys.map((key, i) => ({ key, expected: values[i],
        value: i === 0 ? 'committed' : 'target', ttlMs: 30_000 }));
    await redis.connect();
    try {
        const reset = async () => { for (let i = 0; i < keys.length; i++) await redis.setPx(keys[i], values[i], 30_000); };
        const read = () => Promise.all(keys.map(key => redis.get(key)));
        await reset();
        await redis.setPx(keys[3], 'new-assignment', 30_000);
        assert.equal(await redis.compareAndSetMany(replacements), false);
        assert.deepEqual(await read(), ['pending', 'source', 'source', 'new-assignment']);
        await reset();
        assert.equal(await redis.compareAndSetMany(replacements), true);
        assert.deepEqual(await read(), ['committed', 'target', 'target', 'target']);
        assert.equal(await redis.compareAndSetMany(replacements), false, 'duplicate commit is fenced');
        for (let run = 0; run < 20; run++) {
            await reset();
            const cancel = () => redis.compareAndSetPx(keys[0], 'pending', 'cancelled', 30_000);
            const commit = () => redis.compareAndSetMany(replacements);
            const outcomes = await Promise.all(run % 2 ? [cancel(), commit()] : [commit(), cancel()]);
            assert.equal(outcomes.filter(Boolean).length, 1, 'commit and cancellation cannot both win');
            const snapshot = await read();
            assert.deepEqual(snapshot, snapshot[0] === 'committed'
                ? ['committed', 'target', 'target', 'target'] : ['cancelled', 'source', 'source', 'source']);
        }
        console.log('PASS real Redis atomic handoff: conflict, commit, duplicate and 20 cancel races');
    } finally {
        for (const key of keys) await redis.delete(key);
        await redis.close();
    }
}
const deadline = setTimeout(() => { console.error('Atomic handoff audit exceeded 15 seconds'); process.exit(1); }, 15_000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(deadline));
