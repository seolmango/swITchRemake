import assert from 'node:assert/strict';
import test from 'node:test';
import { MATCH_RESULT_VERSION, type MatchResultMessage } from 'shared';
import { RESULT_STREAM_FIELD } from './result.codec';
import { ResultWorker } from './result.worker';

const result: MatchResultMessage = {
    v: MATCH_RESULT_VERSION,
    matchId: '11111111-1111-4111-8111-111111111111', roomId: 'room', serverId: 'server', mapId: 'map',
    startedAt: 1, endedAt: 2, durationTicks: 1, buildId: 'build', protocolVersion: 1,
    rulesVersion: 'rules', mapBundleHash: 'hash', visibilityCoreVersion: 1,
    winnerPlayerIds: [1, 2], replay: null,
    players: [
        { userId: 1, playerId: 1, nickname: 'A', colorIndex: 0, isGuest: false, tagCount: 0, taggedCount: 0, switchTry: 0, switchSuccess: 0, survivedMs: 1 },
        { userId: null, playerId: 2, nickname: 'Guest_7KPW2M', colorIndex: 1, isGuest: true, tagCount: 0, taggedCount: 0, switchTry: 0, switchSuccess: 0, survivedMs: 1 },
    ],
};

test('acknowledges only after result transaction resolves', async () => {
    const events: string[] = [];
    let release!: () => void;
    const committed = new Promise<void>((resolve) => { release = resolve; });
    const redis = { acknowledge: async () => { events.push('ack'); } };
    const results = { record: async () => { await committed; events.push('commit'); return 'stored' as const; } };
    const worker = new ResultWorker(redis as never, results as never);
    const processing = worker.processEntry({ id: '1-0', fields: { [RESULT_STREAM_FIELD]: JSON.stringify(result) } });
    await Promise.resolve();
    assert.deepEqual(events, []);
    release();
    await processing;
    assert.deepEqual(events, ['commit', 'ack']);
});

test('leaves a valid result pending when database storage fails', async () => {
    let acknowledged = false;
    const redis = { acknowledge: async () => { acknowledged = true; } };
    const results = { record: async () => { throw new Error('database unavailable'); } };
    const worker = new ResultWorker(redis as never, results as never);
    await assert.rejects(worker.processEntry({ id: '2-0', fields: { [RESULT_STREAM_FIELD]: JSON.stringify(result) } }));
    assert.equal(acknowledged, false);
});

test('acknowledges malformed poison entries without calling storage', async () => {
    let records = 0;
    let acknowledgements = 0;
    const redis = { acknowledge: async () => { acknowledgements++; } };
    const results = { record: async () => { records++; return 'stored' as const; } };
    const worker = new ResultWorker(redis as never, results as never);
    await worker.processEntry({ id: '3-0', fields: { [RESULT_STREAM_FIELD]: '{bad json' } });
    assert.equal(records, 0);
    assert.equal(acknowledgements, 1);
});
