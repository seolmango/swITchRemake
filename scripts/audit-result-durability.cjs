'use strict';
// Actual child death + disk recovery + real Redis/match worker/PostgreSQL.
// This is a synthetic result delivery check, separate from real browser games.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { makeKeys } = require('shared');
if (process.env.AUDIT_STACK !== 'true' || process.env.APP_ENV !== 'audit'
    || process.env.DB_HOST !== 'postgres' || process.env.REDIS_HOST !== 'redis'
    || !/^audit_[a-z0-9_]+$/.test(process.env.DB_NAME || '')) throw Error('Disposable audit only');
const keys = makeKeys('audit');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Durability probe deadline exceeded'); process.exit(1); }, 65_000);

async function child(mode, directory) {
    const { RedisClient } = require('../server-game/dist/redis/redis-client');
    const { ResultOutbox } = require('../server-game/dist/redis/result-outbox');
    const redis = new RedisClient({ host: 'redis', port: 6379, password: process.env.REDIS_PASSWORD });
    const outbox = new ResultOutbox({ redis, keys, journalDirectory: directory,
        isPersisted: mode === 'unconfirmed' ? async () => false
            : async result => await redis.get(keys.operation(`result-persisted:${result.matchId}`)) === '1' });
    if (mode === 'offline') {
        const [result] = await once(process, 'message');
        assert.equal(redis.isReady(), false);
        outbox.enqueue(result);
        assert.equal(outbox.size, 1);
        process.send({ state: 'journaled-without-redis' });
    } else {
        await redis.connect();
        if (mode === 'unconfirmed') {
            assert.equal(await outbox.flush(), 1);
            assert.equal(outbox.size, 1, 'XADD cannot erase an unconfirmed journal');
            process.send({ state: 'published-without-receipt' });
        } else {
            let sent = 0;
            while (outbox.size > 0) { sent += await outbox.flush(); await sleep(200); }
            process.send({ state: 'recovered', sent });
            await redis.close(); clearTimeout(deadline); process.disconnect(); return;
        }
    }
    // Parent kills this exact test child with SIGKILL, without graceful cleanup.
    setInterval(() => {}, 1000);
}

async function main() {
    const postgres = require('postgres');
    const Redis = require('ioredis');
    const { drizzle } = require('drizzle-orm/postgres-js');
    const schema = require('../server-match/dist/database/schema');
    const { ResultService } = require('../server-match/dist/results/result.service');
    const db = postgres({ host: 'postgres', username: 'audit', password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME, ssl: false, max: 1, connect_timeout: 5 });
    const redis = new Redis({ host: 'redis', password: process.env.REDIS_PASSWORD, maxRetriesPerRequest: 1, commandTimeout: 3000 });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-result-durability-'));
    const children = [];
    const start = (mode, result) => {
        const child = fork(__filename, [mode, directory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        children.push(child);
        const message = new Promise((resolve, reject) => {
            child.once('message', resolve);
            child.once('error', reject);
            child.once('exit', code => { if (code !== 0) reject(Error(`Durability child exited: ${code}`)); });
        });
        const closed = new Promise(resolve => child.once('exit', resolve));
        if (result) child.send(result);
        return { child, message, closed };
    };
    const kill = async child => { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; };
    try {
        const service = new ResultService(drizzle(db, { schema }));
        const accounts = [];
        for (let index = 0; index < 3; index++) {
            const label = randomUUID().slice(0, 8);
            const [account] = await db`insert into users (email,password_hash,nickname) values (${`durable-${label}@switch.test`}, 'no-login-synthetic-fixture', ${`내구${label}`}) returning id,nickname`;
            accounts.push(account);
        }
        const matchId = randomUUID(), roomId = randomUUID();
        await service.issueMatch(matchId, 'durability-source', 'TestMap1', { id: accounts[0].id, nickname: accounts[0].nickname, guest: false });
        await service.confirmRoom(matchId, roomId, 'TestMap1');
        for (const account of accounts.slice(1)) await service.addAssignmentByRoom(roomId, { id: account.id, nickname: account.nickname, guest: false });
        const result = { v: 1, matchId, roomId, serverId: 'durability-source', mapId: 'TestMap1',
            startedAt: 1000, endedAt: 3000, durationTicks: 60, buildId: 'audit-durability', protocolVersion: 2,
            rulesVersion: 'audit', mapBundleHash: 'audit', visibilityCoreVersion: 1, winnerPlayerIds: [1], replay: null,
            players: accounts.map((a, i) => ({ userId: a.id, nickname: a.nickname, playerId: i + 1, colorIndex: i,
                isGuest: false, tagCount: 0, taggedCount: 0, switchTry: 0, switchSuccess: 0, survivedMs: 2000 })) };
        const file = path.join(directory, `${createHash('sha256').update(matchId).digest('hex')}.json`);
        const offline = start('offline', result);
        assert.equal((await offline.message).state, 'journaled-without-redis');
        await kill(offline.child);
        assert.equal(fs.existsSync(file), true);
        const [notCommitted] = await db`select result_recorded_at from matches where match_id=${matchId}`;
        assert.equal(notCommitted.result_recorded_at, null);
        const unconfirmed = start('unconfirmed');
        assert.equal((await unconfirmed.message).state, 'published-without-receipt');
        await kill(unconfirmed.child);
        assert.equal(fs.existsSync(file), true);
        const receipt = keys.operation(`result-persisted:${matchId}`);
        for (let i = 0; i < 100 && await redis.get(receipt) !== '1'; i++) await sleep(100);
        assert.equal(await redis.get(receipt), '1', 'actual match worker committed and issued receipt');
        const before = await db`select stats from users where id in (${accounts[0].id}, ${accounts[1].id}, ${accounts[2].id}) order by id`;
        assert.deepEqual(before.map(row => row.stats.games), [1, 1, 1]);
        await redis.del(receipt); // Lose only this synthetic receipt; force at-least-once replay.
        const recovered = start('recover');
        const recovery = await recovered.message;
        assert.equal(recovery.state, 'recovered'); assert.equal(recovery.sent, 1);
        assert.equal(await recovered.closed, 0);
        assert.equal(fs.existsSync(file), false, 'remove journal only after renewed DB receipt');
        assert.equal(await redis.get(receipt), '1');
        assert.deepEqual(await db`select stats from users where id in (${accounts[0].id}, ${accounts[1].id}, ${accounts[2].id}) order by id`, before);
        assert.equal((await db`select player_id from match_participants where match_id=${matchId}`).length, 3);
        const evidence = { passed: true, disconnectedProducerKilled: true, unconfirmedPublisherKilled: true,
            actualRedisAndPostgresRecovery: true, receiptLossRedelivery: true, participants: 3, statsAndXpExactlyOnce: true };
        fs.mkdirSync('/app/e2e/artifacts/audit', { recursive: true });
        fs.writeFileSync('/app/e2e/artifacts/audit/result-durability.json', JSON.stringify(evidence, null, 2));
        console.log(JSON.stringify(evidence));
    } finally {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await redis.quit(); await db.end(); fs.rmSync(directory, { recursive: true, force: true }); clearTimeout(deadline);
    }
}
(process.argv[2] ? child(process.argv[2], process.argv[3]) : main()).catch(error => {
    console.error('Durability probe failed:', error.name, error.message); clearTimeout(deadline); process.exitCode = 1;
    if (process.argv[2]) process.exit(1);
});
