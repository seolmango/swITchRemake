import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeInput, encodeInput, InputDecodeError, isNewerSequence, movementVector } from './input';
import { decodeSnapshot, SnapshotDecodeError } from './snapshot';
import { parseReplayContainer, ReplayDecodeError } from '../replay/format';

// Fixed seed, <=512 bytes/input, 512 iterations. No networking or decompression.
// Failures preserve the exact small input; this is a bounded corpus, not a proof
// that every possible protocol message or replay is safe.
const seed = 0x41004;
function randomGenerator() {
    let state = seed;
    return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}

test('seeded normal movement never exceeds one unit or breaks sequence wrap', { timeout: 2_000 }, () => {
    const next = randomGenerator();
    for (let index = 0; index < 512; index++) {
        const flags = next() & 15;
        const sequence = next() & 65535;
        const state = { sequence, left: !!(flags & 1), right: !!(flags & 2), up: !!(flags & 4), down: !!(flags & 8), heldActions: 0 };
        const decoded = decodeInput(encodeInput(state));
        const hint = `seed=${seed}; sample=${index}; flags=${flags}; sequence=${sequence}`;
        assert.deepEqual(decoded, state, hint);
        const vector = movementVector(decoded);
        assert.ok(Number.isFinite(vector.x) && Number.isFinite(vector.y), hint);
        assert.ok(Math.hypot(vector.x, vector.y) <= 1 + Number.EPSILON, hint);
        if (state.left === state.right) assert.equal(vector.x, 0, hint);
        if (state.up === state.down) assert.equal(vector.y, 0, hint);
        assert.equal(isNewerSequence(sequence, sequence), false, hint);
        assert.equal(isNewerSequence((sequence + 1) % 65536, sequence), true, hint);
        assert.equal(isNewerSequence((sequence + 65535) % 65536, sequence), false, hint);
    }
});

test('seeded bounded untrusted bytes terminate with typed parser rejection or valid objects', { timeout: 2_000 }, () => {
    const next = randomGenerator();
    for (let index = 0; index < 512; index++) {
        const bytes = Uint8Array.from({ length: next() % 513 }, () => next() & 255);
        const hint = `seed=${seed}; sample=${index}; bytes=${Buffer.from(bytes).toString('hex')}`;
        for (const [parse, rejection] of [
            [() => decodeInput(bytes.buffer), InputDecodeError],
            [() => decodeSnapshot(bytes.buffer), SnapshotDecodeError],
            [() => parseReplayContainer(bytes), ReplayDecodeError],
        ] as const) {
            try { const value = parse(); assert.ok(value && typeof value === 'object', hint); }
            catch (error) { assert.ok(error instanceof rejection, `${hint}; unexpected ${error instanceof Error ? error.name : typeof error}`); }
        }
    }
});
