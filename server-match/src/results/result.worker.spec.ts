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
    const results = { record: async () => { await committed; events.push('commit'); return 'stored' as const; }, issueNextMatch: async () => null };
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

test('a failed next-match delivery stays pending and a committed duplicate retries the same grant', async () => {
    let stored = false;
    let records = 0;
    let sends = 0;
    let acknowledgements = 0;
    const sent: string[] = [];
    const redis = {
        acknowledge: async () => { acknowledgements++; },
        addStreamEntry: async (_stream: string, _field: string, command: string) => {
            const { payload } = JSON.parse(command);
            sent.push(payload.matchId);
            if (++sends === 1) throw new Error('injected Redis delivery failure');
        },
    };
    const results = {
        record: async () => { if (stored) return 'duplicate' as const; stored = true; records++; return 'stored' as const; },
        issueNextMatch: async () => '22222222-2222-4222-8222-222222222222',
    };
    const entry = { id: '4-0', fields: { [RESULT_STREAM_FIELD]: JSON.stringify(result) } };
    await assert.rejects(new ResultWorker(redis as never, results as never).processEntry(entry), /injected Redis/);
    assert.equal(acknowledgements, 0, 'the already committed result must remain pending until grant delivery succeeds');
    // A new worker simulates a process restart, so in-memory retry state cannot hide a loss.
    await new ResultWorker(redis as never, results as never).processEntry(entry);
    assert.equal(records, 1);
    assert.equal(acknowledgements, 1);
    assert.deepEqual(sent, ['22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222']);
});

test('a next-match database failure stays pending and invalid results never issue grants', async () => {
    let acknowledgements = 0;
    let grants = 0;
    const redis = { acknowledge: async () => { acknowledgements++; } };
    const results = { record: async () => 'stored' as const, issueNextMatch: async () => { grants++; throw new Error('injected grant database failure'); } };
    const entry = { id: '5-0', fields: { [RESULT_STREAM_FIELD]: JSON.stringify(result) } };
    await assert.rejects(new ResultWorker(redis as never, results as never).processEntry(entry), /injected grant database/);
    assert.equal(acknowledgements, 0);
    const invalid = { ...results, record: async () => 'invalid' as const };
    await new ResultWorker(redis as never, invalid as never).processEntry(entry);
    assert.equal(acknowledgements, 1);
    assert.equal(grants, 1);
});
