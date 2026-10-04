import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeKeys } from 'shared';
import { readServers, readScalingPolicy, decideLocalScaling } from './main';
import { DEFAULT_POLICY } from './policy';

test('missing registry heartbeats never grow live OS children beyond the configured maximum', () => {
    const input = { servers: [], starting: 0, now: 100_000, lastActionAt: null,
        policy: { ...DEFAULT_POLICY, minServers: 1, maxServers: 2 } };
    // Both children are alive but their earlier heartbeats expired. Minimum
    // capacity recovery would otherwise bypass cooldown on every tick.
    assert.equal(decideLocalScaling(input, 2).kind, 'hold');
    assert.equal(decideLocalScaling(input, 3).kind, 'hold');
    assert.equal(decideLocalScaling(input, 1).kind, 'up');
    assert.equal(decideLocalScaling({ ...input, starting: 1 }, 2).kind, 'hold');
});

test('scaling overrides preserve capacity bounds and distinct thresholds', () => {
    assert.deepEqual(readScalingPolicy({}), DEFAULT_POLICY);
    assert.deepEqual(readScalingPolicy({ SUPERVISOR_MIN_SERVERS: '1', SUPERVISOR_MAX_SERVERS: '2',
        SUPERVISOR_SCALE_UP_LOAD: '2', SUPERVISOR_SCALE_DOWN_LOAD: '1.3', SUPERVISOR_COOLDOWN_MS: '5000' }),
    { minServers: 1, maxServers: 2, scaleUpLoad: 2, scaleDownLoad: 1.3, cooldownMs: 5000 });
    for (const invalid of [
        { SUPERVISOR_MIN_SERVERS: '0' }, { SUPERVISOR_MAX_SERVERS: '0' },
        { SUPERVISOR_MAX_SERVERS: '2.5' }, { SUPERVISOR_MAX_SERVERS: '100' },
        { SUPERVISOR_SCALE_UP_LOAD: '1' }, { SUPERVISOR_SCALE_DOWN_LOAD: '-1' },
        { SUPERVISOR_COOLDOWN_MS: 'NaN' }, { SUPERVISOR_COOLDOWN_MS: '-1' },
    ]) assert.throws(() => readScalingPolicy(invalid), /Invalid scaling policy/);
});

test('failed registry reads are unknown capacity, rather than an empty fleet to replace', async () => {
    const redis = {
        zrange: async () => { throw new Error('synthetic local outage'); },
        get: async () => null,
    };
    assert.equal(await readServers(redis as never, makeKeys('audit')), null);
});

test('null, stale, mismatched and invalid load heartbeats cannot enter scaling decisions', async () => {
    const valid = { serverId: 'good', maxRooms: 10, waitingRooms: 1, playingRooms: 2,
        connections: 3, loopLagMs: 1, draining: false, updatedAt: Date.now() };
    const values = new Map([
        ['good', valid], ['null', null], ['wrong', valid],
        ['stale', { ...valid, serverId: 'stale', updatedAt: 0 }],
        ['bad', { ...valid, serverId: 'bad', connections: -1 }],
    ]);
    const redis = { zrange: async () => [...values.keys()],
        get: async (key: string) => JSON.stringify(values.get(key.split(':').at(-1)!)) };
    assert.deepEqual((await readServers(redis as never, makeKeys('audit')))?.map(server => server.serverId), ['good']);
});
