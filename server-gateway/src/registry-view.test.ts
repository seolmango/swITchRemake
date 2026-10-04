import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Redis from 'ioredis';
import { makeKeys, type GameServerHeartbeat } from 'shared';
import { RegistryView } from './registry-view';

const NOW = 10_000;

function heartbeat(serverId: string, overrides: Partial<GameServerHeartbeat> = {}): GameServerHeartbeat {
    return {
        serverId,
        buildVersion: 'build',
        protocolVersion: 2,
        rulesVersion: 'rules',
        mapBundleHash: 'a'.repeat(64),
        waitingRooms: 1,
        playingRooms: 1,
        connections: 4,
        loopLagMs: 2,
        draining: false,
        updatedAt: NOW,
        internalAddress: 'http://127.0.0.1:4000',
        maxRooms: 100,
        ...overrides,
    };
}

test('runtime schema와 주소 allowlist를 통과한 최신 heartbeat만 라우팅에 넣는다', async () => {
    const keys = makeKeys('test');
    const values = new Map<string, string>();
    const entries: GameServerHeartbeat[] = [
        heartbeat('valid'),
        heartbeat('https', { internalAddress: 'https://127.0.0.1:4000' }),
        heartbeat('host', { internalAddress: 'http://169.254.169.254:4000' }),
        heartbeat('port', { internalAddress: 'http://127.0.0.1:9000' }),
        heartbeat('load', { connections: -1 }),
        heartbeat('stale', { updatedAt: NOW - 6_001 }),
        heartbeat('future', { updatedAt: NOW + 2_001 }),
    ];
    for (const entry of entries) values.set(keys.gameServer(entry.serverId), JSON.stringify(entry));
    const redis = {
        zrange: async () => entries.map((entry) => entry.serverId),
        get: async (key: string) => values.get(key) ?? null,
    } as unknown as Redis;
    const logs: string[] = [];
    const view = new RegistryView({
        redis,
        keys,
        now: () => NOW,
        addressPolicy: {
            allowedHosts: ['127.0.0.1'],
            allowedPortRanges: [{ min: 4000, max: 4999 }],
        },
        logger: (message) => logs.push(message),
    });

    await view.refresh();
    assert.deepEqual([...view.servers.keys()], ['valid']);
    assert.equal(logs.length, entries.length - 1);
});

test('JSON이 깨졌거나 serverId가 다른 heartbeat도 직전 값 대신 제외한다', async () => {
    const keys = makeKeys('test');
    const redis = {
        zrange: async () => ['broken', 'mismatch'],
        get: async (key: string) => key.endsWith('broken') ? '{' : JSON.stringify(heartbeat('someone-else')),
    } as unknown as Redis;
    const view = new RegistryView({
        redis,
        keys,
        now: () => NOW,
        addressPolicy: { allowedHosts: ['127.0.0.1'], allowedPortRanges: [{ min: 4000, max: 4000 }] },
    });
    await view.refresh();
    assert.equal(view.servers.size, 0);
});

test('cache-miss lookup coalesces grants and preserves heartbeat/address validation', async () => {
    const keys = makeKeys('test');
    let reads = 0;
    const redis = { get: async (key: string) => {
        reads++;
        return JSON.stringify(heartbeat(key.endsWith('new') ? 'new' : 'foreign',
            key.endsWith('new') ? {} : { internalAddress: 'http://169.254.169.254:4000' }));
    } } as unknown as Redis;
    const view = new RegistryView({ redis, keys, now: () => NOW,
        addressPolicy: { allowedHosts: ['127.0.0.1'], allowedPortRanges: [{ min: 4000, max: 4000 }] } });
    const grants = await Promise.all(Array.from({ length: 24 }, () => view.ensureServer('new')));
    assert.ok(grants.every(server => server?.serverId === 'new'));
    assert.equal(reads, 1);
    assert.equal(await view.ensureServer('foreign'), null);
    assert.equal(await view.ensureServer('../bad'), null);
    assert.equal(reads, 2);
    assert.equal(view.servers.has('foreign'), false);
});

test('arbitrary unknown upgrade IDs cannot cause unbounded Redis lookup work', async () => {
    let reads = 0;
    const redis = { get: async () => { reads++; return null; } } as unknown as Redis;
    const view = new RegistryView({ redis, keys: makeKeys('test'), now: () => NOW,
        addressPolicy: { allowedHosts: ['127.0.0.1'], allowedPortRanges: [{ min: 4000, max: 4000 }] } });
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) => view.ensureServer(`unknown-${index}`)));
    assert.ok(results.every(server => server === null));
    assert.equal(reads, 16);
    assert.equal(await view.ensureServer('another'), null);
    assert.equal(reads, 16);
});

test('cache-miss Redis lookup ends within the upgrade handshake budget', { timeout: 2_500 }, async () => {
    const redis = { get: () => new Promise(() => undefined) } as unknown as Redis;
    const view = new RegistryView({ redis, keys: makeKeys('test'), now: () => NOW,
        addressPolicy: { allowedHosts: ['127.0.0.1'], allowedPortRanges: [{ min: 4000, max: 4000 }] } });
    const startedAt = Date.now();
    assert.equal(await view.ensureServer('new'), null);
    assert.ok(Date.now() - startedAt >= 900 && Date.now() - startedAt < 2_000);
});

test('timed-out callers retain the underlying Redis concurrency budget across windows', { timeout: 3_000 }, async () => {
    let reads = 0;
    let now = NOW;
    const redis = { get: () => { reads++; return new Promise(() => undefined); } } as unknown as Redis;
    const view = new RegistryView({ redis, keys: makeKeys('test'), now: () => now,
        addressPolicy: { allowedHosts: ['127.0.0.1'], allowedPortRanges: [{ min: 4000, max: 4000 }] } });
    await Promise.all(Array.from({ length: 16 }, (_, index) => view.ensureServer(`first-${index}`)));
    assert.equal(reads, 16);
    now += 2_001;
    const next = await Promise.all(Array.from({ length: 100 }, (_, index) => view.ensureServer(`later-${index}`)));
    assert.ok(next.every(server => server === null));
    assert.equal(reads, 16, 'caller timeouts never permit more than sixteen unresolved Redis operations');
});
