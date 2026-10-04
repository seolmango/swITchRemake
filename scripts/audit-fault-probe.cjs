'use strict';
const assert = require('node:assert/strict');
const Redis = require('ioredis');
const postgres = require('postgres');
const bcrypt = require('bcrypt');
const { randomBytes } = require('node:crypto');
if (process.env.AUDIT_STACK !== 'true' || process.env.APP_ENV !== 'audit') throw new Error('Fault probe requires audit');
const action = process.argv[2];
async function main() {
    if (action === 'egress') {
        const net = require('node:net');
        for (const host of ['smtp.gmail.com', 'production.invalid', '169.254.169.254']) {
            assert.throws(() => net.connect({ host, port: 443 }), /AUDIT_EGRESS_DENIED/);
        }
    } else if (action === 'health-down' || action === 'health-up') {
        const deadline = Date.now() + 25_000;
        let passed = false;
        while (Date.now() < deadline) {
            try {
                const response = await fetch('http://web/api/health/ready', { signal: AbortSignal.timeout(4_000) });
                if (response.status === (action === 'health-down' ? 503 : 200)) { passed = true; break; }
            } catch { /* bounded wait during restart */ }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        assert.equal(passed, true, action);
    } else if (action === 'replay-denied' || action === 'replay-restored') {
        const { LocalReplayStore } = require('../server-game/dist/replay/replay-store');
        const store = new LocalReplayStore('/app/replays');
        const key = `audit-fault-${randomBytes(6).toString('hex')}.swrp`;
        if (action === 'replay-denied') await assert.rejects(store.put(key, Buffer.from('audit')), error => error.code === 'EACCES');
        else { await store.put(key, Buffer.from('audit')); await store.delete(key); }
    } else {
        const redis = new Redis({ host: 'redis', password: process.env.REDIS_PASSWORD, maxRetriesPerRequest: 1 });
        const db = postgres({ host: 'postgres', username: 'audit', password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME, ssl: false, max: 1 });
        try {
            if (action === 'seed') {
                const suffix = randomBytes(4).toString('hex');
                const email = `fault${suffix}@switch.test`;
                const password = `${randomBytes(6).toString('hex')}!Au`;
                const hash = await bcrypt.hash(password, 10);
                const [user] = await db`insert into users (email,password_hash,nickname) values (${email},${hash},${`fault${suffix}`}) returning id`;
                const response = await fetch('http://web/api/auth/login', {
                    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(5_000),
                });
                assert.equal(response.status, 201, 'fault synthetic login');
                const login = await response.json();
                assert.equal(typeof login.accessToken, 'string');
                await redis.set('audit:fault:session', JSON.stringify({ userId: user.id, token: login.accessToken }), 'EX', 600);
                // Redis AOF everysec must persist this synthetic marker before the stop.
                await new Promise(resolve => setTimeout(resolve, 1_200));
            } else if (action === 'session') {
                const state = JSON.parse(await redis.get('audit:fault:session'));
                const response = await fetch('http://web/api/users/me/stats', { headers: { authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(5_000) });
                assert.equal(response.status, 200, 'session retained across restart');
                const [user] = await db`select id from users where id=${state.userId}`;
                assert.equal(user.id, state.userId, 'database retained across restart');
                // Retain the synthetic marker until its TTL for the later Redis
                // and matching-process restart checks in this same fault run.
            } else throw new Error('Unknown audit probe');
        } finally { redis.disconnect(); await db.end(); }
    }
    console.log(JSON.stringify({ faultProbe: action, passed: true }));
}
main().catch(() => { console.error(JSON.stringify({ faultProbe: action, passed: false })); process.exitCode = 1; });
