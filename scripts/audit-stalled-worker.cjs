'use strict';
// Only empty, verified children of the disposable audit supervisor may be paused.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const Redis = require('ioredis');
const { makeKeys } = require('shared');
const root = path.resolve(__dirname, '..');
const gameEntry = path.join(root, 'server-game/dist/main.js');
const supervisorEntry = path.join(root, 'server-supervisor/dist/main.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function guard() {
    assert.equal(process.platform, 'linux');
    assert.ok(fs.existsSync('/.dockerenv'));
    assert.equal(process.env.AUDIT_STACK, 'true');
    assert.equal(process.env.APP_ENV, 'audit');
    assert.equal(process.env.REDIS_HOST, 'redis');
    assert.equal(process.env.DB_HOST, 'postgres');
    assert.match(process.env.DB_NAME || '', /^audit_[a-z0-9_]+$/);
    assert.equal(Number(process.env.SUPERVISOR_MIN_SERVERS), 1);
    assert.equal(Number(process.env.SUPERVISOR_MAX_SERVERS), 2);
}
function command(pid) { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); }
function identity(pid) {
    assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
    assert.equal(command(pid)[1], gameEntry);
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const parentPid = Number(status.match(/^PPid:\s+(\d+)$/m)?.[1]);
    assert.equal(command(parentPid)[1], supervisorEntry);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    assert.match(startTime, /^\d+$/);
    const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    const serverId = env.split('\0').find(entry => entry.startsWith('GAME_SERVER_ID='))?.slice(15);
    assert.match(serverId || '', /^game-auto-[a-z0-9-]+$/);
    return { pid, parentPid, startTime, serverId };
}
function sameChild(target) {
    try { const current = identity(target.pid); return current.parentPid === target.parentPid
        && current.startTime === target.startTime && current.serverId === target.serverId; }
    catch { return false; }
}
function children() {
    return fs.readdirSync('/proc').filter(id => /^\d+$/.test(id)).flatMap(id => {
        try { return command(Number(id))[1] === gameEntry ? [identity(Number(id))] : []; }
        catch { return []; }
    });
}
function resume(targets) {
    for (const target of targets) if (sameChild(target)) {
        try { process.kill(target.pid, 'SIGCONT'); }
        catch { /* keep attempting all targets; the independent watchdog retries */ }
    }
}
async function watchdog(recordPath) {
    assert.match(recordPath, /^\/tmp\/audit-stalled-[0-9a-f-]{36}\.json$/);
    const deadline = Date.now() + 55_000;
    while (Date.now() < deadline) {
        let record;
        try { record = JSON.parse(fs.readFileSync(recordPath, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        assert.ok(Array.isArray(record.targets) && record.targets.length <= 2);
        assert.ok(Number.isSafeInteger(record.resumeAt) && record.resumeAt <= Date.now() + 55_000);
        fs.writeFileSync(`${recordPath}.ready`, 'ready', { mode: 0o600 });
        if (Date.now() >= record.resumeAt) { resume(record.targets); return; }
        await sleep(100);
    }
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    resume(record.targets);
}
async function main() {
    const startedAt = Date.now();
    const activeDeadline = startedAt + 38_000;
    const recordPath = `/tmp/audit-stalled-${randomUUID()}.json`;
    const stopped = [];
    const evidence = [];
    const saveTargets = () => {
        const next = `${recordPath}.next`;
        fs.writeFileSync(next, JSON.stringify({ targets: stopped, resumeAt: startedAt + 50_000 }), { mode: 0o600 });
        fs.renameSync(next, recordPath);
    };
    saveTargets();
    // A separate session survives termination/crash of this probe and resumes
    // only these same PID/start-time identities after fifty seconds.
    const guardian = spawn(process.execPath, [__filename, '--watchdog', recordPath], { detached: true, stdio: 'ignore' });
    let guardianExited = false;
    guardian.once('error', () => { guardianExited = true; });
    guardian.once('exit', () => { guardianExited = true; });
    guardian.unref();
    const redis = new Redis({ host: 'redis', password: process.env.REDIS_PASSWORD,
        maxRetriesPerRequest: 1, connectTimeout: 2_000, commandTimeout: 2_000, retryStrategy: () => null });
    redis.on('error', () => undefined);
    const keys = makeKeys('audit');
    const emergencyResume = () => { resume(stopped); redis.disconnect(); process.exit(1); };
    const timer = setTimeout(emergencyResume, 58_000);
    process.once('SIGINT', emergencyResume); process.once('SIGTERM', emergencyResume);
    const fleet = async () => {
        assert.equal(await redis.ping(), 'PONG', 'Redis remains healthy');
        const ids = await redis.zrange(keys.gameServersAlive(), 0, -1);
        const values = await Promise.all(ids.map(id => redis.get(keys.gameServer(id))));
        return values.flatMap(raw => { if (!raw) return []; const value = JSON.parse(raw);
            return value.updatedAt > Date.now() - 6_000 ? [value] : []; });
    };
    const until = async (predicate, limit = activeDeadline) => {
        while (Date.now() < limit) { if (await predicate()) return; await sleep(200); }
        throw new Error('Bounded stalled-worker phase timed out');
    };
    const pause = async target => {
        assert.ok(stopped.length < 2);
        assert.equal(guardianExited, false, 'Independent recovery watchdog remains alive');
        process.kill(guardian.pid, 0);
        assert.ok(sameChild(target), 'Exact game child identity still matches');
        const heartbeat = (await fleet()).find(server => server.serverId === target.serverId);
        assert.ok(heartbeat && !heartbeat.draining);
        assert.equal(heartbeat.waitingRooms + heartbeat.playingRooms, 0, 'Only an empty worker may be paused');
        assert.equal(heartbeat.connections, 0, 'Only a disconnected worker may be paused');
        stopped.push(target); saveTargets();
        process.kill(target.pid, 'SIGSTOP');
    };
    try {
        await until(async () => fs.existsSync(`${recordPath}.ready`), Date.now() + 3_000);
        await until(async () => children().length === 1 && (await fleet()).length === 1,
            Math.min(activeDeadline, Date.now() + 10_000));
        const original = children()[0];
        await pause(original);
        await until(async () => {
            assert.ok(children().length <= 2, 'OS child cap includes stalled and starting workers');
            return children().length === 2 && (await fleet()).some(server => server.serverId !== original.serverId && !server.draining);
        });
        const replacement = children().find(target => target.pid !== original.pid);
        assert.ok(replacement);
        await pause(replacement);
        await until(async () => (await fleet()).length === 0);
        const observedUntil = Date.now() + 12_000;
        assert.ok(observedUntil < activeDeadline, 'Twelve-second observation fits the bounded budget');
        while (Date.now() < observedUntil) {
            assert.equal(await redis.ping(), 'PONG');
            assert.equal(children().length, 2, 'Two stalled live OS children must never authorize a third');
            assert.equal((await fleet()).length, 0, 'Both worker heartbeats are stale');
            assert.ok(stopped.every(sameChild), 'Stopped child identities remain unchanged');
            await sleep(250);
        }
        evidence.push({ phase: 'healthy-redis-stale-heartbeats', aliveOsChildren: 2,
            freshHeartbeats: 0, maxServers: 2, observationMs: 12_000, passed: true });
    } finally {
        resume(stopped);
        try {
            await until(async () => children().length === 1 && (await fleet()).length === 1,
                Math.min(startedAt + 57_000, Date.now() + 18_000));
            evidence.push({ phase: 'resumed-idle-one', aliveOsChildren: 1, passed: true });
        } finally {
            clearTimeout(timer); process.off('SIGINT', emergencyResume); process.off('SIGTERM', emergencyResume);
            redis.disconnect();
            // Leave the independent guardian record if a target still exists in
            // STOP state; otherwise deletion safely ends that watchdog.
            const anyStopped = stopped.some(target => {
                try { return sameChild(target) && /^State:\s+T/m.test(fs.readFileSync(`/proc/${target.pid}/status`, 'utf8')); }
                catch { return false; }
            });
            if (!anyStopped) {
                fs.unlinkSync(recordPath);
                fs.rmSync(`${recordPath}.ready`, { force: true });
            }
            fs.writeFileSync('/tmp/audit-stalled-worker.json', JSON.stringify({ evidence, elapsedMs: Date.now() - startedAt }, null, 2));
        }
    }
    console.log(JSON.stringify({ stalledWorkerProbe: true, passed: true, evidence, elapsedMs: Date.now() - startedAt }));
}
guard();
(process.argv[2] === '--watchdog' ? watchdog(process.argv[3]) : main()).catch(() => {
    console.error(JSON.stringify({ stalledWorkerProbe: true, passed: false })); process.exitCode = 1;
});
