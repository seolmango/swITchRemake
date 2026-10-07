'use strict';
const fs = require('node:fs');
const Redis = require('ioredis');
if (process.env.AUDIT_STACK !== 'true' || process.env.APP_ENV !== 'audit') throw new Error('Scaling observation requires audit');
const output = '/tmp/audit-scaling-processes.json';
const key = 'audit:scaling:phase';
const redis = new Redis({ host: 'redis', password: process.env.REDIS_PASSWORD, maxRetriesPerRequest: 1 });
const evidence = [];
function children() {
    return fs.readdirSync('/proc').filter(id => /^\d+$/.test(id)).filter(id => {
        try { return (fs.readFileSync(`/proc/${id}/cmdline`, 'utf8').split('\0')[1] || '').endsWith('/server-game/dist/main.js'); }
        catch { return false; }
    }).map(Number).sort((a, b) => a - b);
}
async function main() {
    await redis.del(key);
    const idleDeadline = Date.now() + 1_200_000;
    let activeDeadline = Infinity;
    let last;
    let pendingAt = 0;
    while (Date.now() < Math.min(idleDeadline, activeDeadline)) {
        const phase = await redis.get(key);
        if (phase && phase !== last) {
            if (!Number.isFinite(activeDeadline)) activeDeadline = Date.now() + 330_000;
            if (!pendingAt) pendingAt = Date.now();
            const expected = phase === 'scaled-two' ? 2 : 1;
            const pids = children();
            if (pids.length === expected || Date.now() - pendingAt > 10_000) {
                evidence.push({ phase, pids, gameChildren: pids.length, expected, passed: pids.length === expected, at: new Date().toISOString() });
                last = phase; pendingAt = 0;
                fs.writeFileSync(output, JSON.stringify({ source: 'cluster Linux procfs', evidence }, null, 2));
                if (phase === 'complete') return;
            }
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    fs.writeFileSync(output, JSON.stringify({ source: 'cluster Linux procfs', evidence, timeout: true }, null, 2));
}
main().catch(() => fs.writeFileSync(output, JSON.stringify({ source: 'cluster Linux procfs', evidence, failed: true })))
    .finally(() => redis.disconnect());
