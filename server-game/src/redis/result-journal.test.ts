import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeKeys, type MatchResultMessage } from 'shared';
import { MAX_RESULT_JOURNAL_BYTES, ResultJournal } from './result-journal';
import { ResultOutbox } from './result-outbox';
import type { RedisPort } from './redis-client';

function result(matchId: string): MatchResultMessage {
    return { v: 1, matchId, roomId: 'room', serverId: 'old-worker', mapId: 'map', startedAt: 1,
        endedAt: 2, durationTicks: 1, buildId: 'build', protocolVersion: 2, rulesVersion: 'rules',
        mapBundleHash: 'hash', visibilityCoreVersion: 1, winnerPlayerIds: [], replay: null, players: [] };
}

function harness(directory: string, maxEntries = 2) {
    const state = { ready: true, fail: false, time: 0, persisted: new Set<string>(), sent: [] as string[] };
    const leases = new Map<string, { value: string; expires: number }>();
    const redis = {
        isReady: () => state.ready,
        async setPxIfAbsent(key: string, value: string, ttl: number) {
            if ((leases.get(key)?.expires ?? -1) > state.time) return false;
            leases.set(key, { value, expires: state.time + ttl }); return true;
        },
        async compareAndDelete(key: string, value: string) {
            if (leases.get(key)?.value !== value) return false;
            return leases.delete(key);
        },
        async xAdd(_stream: string, _field: string, value: string) {
            if (state.fail) throw new Error('Redis offline');
            state.sent.push((JSON.parse(value) as MatchResultMessage).matchId); return '1-0';
        },
    } as unknown as RedisPort;
    const options = { redis, keys: makeKeys('test'), journalDirectory: directory, maxEntries,
        isPersisted: async (r: MatchResultMessage) => state.persisted.has(r.matchId) };
    return { state, options, outbox: new ResultOutbox(options) };
}

test('durable journal survives killed producer and a different worker drains only after DB acknowledgement', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'switch-journal-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const script = `const {ResultJournal}=require(process.argv[1]);
        new ResultJournal(process.argv[2]).append(JSON.parse(process.argv[3]));
        process.kill(process.pid,'SIGKILL');`;
    const child = spawnSync(process.execPath, ['-e', script, require.resolve('./result-journal'), directory,
        JSON.stringify(result('crash-result'))], { encoding: 'utf8' });
    assert.notEqual(child.status, 0);
    assert.equal(child.error, undefined);
    const h = harness(directory);
    assert.equal(h.outbox.size, 1);
    h.state.ready = false;
    assert.equal(await h.outbox.flush(), 0);
    h.state.ready = true;
    assert.equal(await h.outbox.flush(), 1);
    assert.equal(h.outbox.size, 1, 'Redis accepted the result, but DB has not committed');
    const adopter = new ResultOutbox(h.options);
    assert.equal(await adopter.flush(), 0, 'shared publication lease suppresses duplicate worker delivery');
    h.state.time += 30_001;
    assert.equal(await adopter.flush(), 1, 'missing ACK causes durable replay after worker or Redis failure');
    h.state.persisted.add('crash-result');
    await adopter.flush();
    assert.equal(h.outbox.size, 0);
});

test('disk write failure retains memory, blocks new games and retries while Redis is down', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'switch-journal-'));
    const storage = join(directory, 'storage');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = harness(storage);
    renameSync(storage, join(directory, 'saved'));
    writeFileSync(storage, 'not a directory');
    assert.throws(() => h.outbox.enqueue(result('disk-failure')));
    assert.equal(h.outbox.canStartNewGame(), false);
    assert.equal(await h.outbox.flush(), 0);
    rmSync(storage);
    renameSync(join(directory, 'saved'), storage);
    h.state.ready = false;
    await h.outbox.flush();
    assert.equal(h.outbox.size, 1);
    assert.equal(new ResultJournal(storage).entries()[0]?.matchId, 'disk-failure');
    assert.equal(h.outbox.canStartNewGame(), true);
});

test('journal detects altered valid JSON and conflicting duplicate IDs without deleting originals', (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'switch-journal-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const journal = new ResultJournal(directory);
    journal.append(result('a'));
    journal.append(result('a'));
    assert.equal(journal.entries().length, 1);
    assert.throws(() => journal.append({ ...result('a'), endedAt: 3 }), /Conflicting/);
    const file = join(directory, readdirSync(directory).find(name => name.endsWith('.json'))!);
    const data = JSON.parse(readFileSync(file, 'utf8')) as { checksum: string; payload: string };
    data.payload = data.payload.replace('old-worker', 'new-worker');
    writeFileSync(file, JSON.stringify(data));
    assert.throws(() => journal.entries(), /Corrupt/);
    assert.throws(() => harness(directory), /Corrupt/);
    assert.equal(readdirSync(directory).filter(name => name.endsWith('.json')).length, 1);
});

test('capacity stops new games while preserving in-flight completions; failed publication releases lease', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'switch-journal-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const h = harness(directory, 1);
    h.outbox.enqueue(result('a'));
    assert.equal(h.outbox.canStartNewGame(), false);
    h.outbox.enqueue(result('b'));
    assert.equal(h.outbox.size, 2);
    h.state.fail = true;
    assert.equal(await h.outbox.flush(), 0);
    h.state.fail = false;
    assert.equal(await h.outbox.flush(), 2);
    h.state.persisted.add('a'); h.state.persisted.add('b');
    await Promise.all([h.outbox.flush(), new ResultOutbox(h.options).flush()]);
    assert.equal(h.outbox.canStartNewGame(), true);
});

test('journal batches rotate without starvation, count avoids parsing, and oversized or corrupt data fail closed', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'switch-journal-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const journal = new ResultJournal(directory);
    for (let i = 0; i < 129; i++) journal.append(result(`batch-${i}`));
    const first = journal.entries();
    const second = journal.entries();
    assert.equal(first.length, 128);
    assert.equal(new Set([...first, ...second].map(r => r.matchId)).size, 129);
    assert.equal(journal.count(), 129);
    const h = harness(directory, 200);
    assert.throws(() => h.outbox.enqueue({ ...result('oversized'), mapId: 'x'.repeat(MAX_RESULT_JOURNAL_BYTES) }), /size limit/);
    assert.equal(h.outbox.canStartNewGame(), false);
    assert.equal(await h.outbox.flush(), 0);
    const file = join(directory, readdirSync(directory).find(name => name.endsWith('.json'))!);
    writeFileSync(file, 'x'.repeat(MAX_RESULT_JOURNAL_BYTES + 1));
    assert.equal(journal.count(), 129, 'count only reads file names');
    assert.throws(() => journal.entries(200), /size limit/);
    writeFileSync(file, '{"private-player-name":BROKEN}');
    assert.throws(() => journal.entries(200), error => error instanceof Error &&
        error.message.startsWith('Corrupt result journal entry:') && !error.message.includes('private-player-name'));
});
