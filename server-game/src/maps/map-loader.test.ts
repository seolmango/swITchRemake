import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeMapBundleHash, instantiateMap, MapBundleError, parseMapBundle } from './map-loader';

function fixture(simulationHz = 60) {
    const unsigned = {
        schemaVersion: 2,
        simulationHz,
        tileSize: 256,
        maps: {
            arena: {
                size: 2,
                barrier_speed: 1,
                initial_map: [[0, 1], [2, 3]],
                timeline: { '2': [[1, 0, 0]] },
                start_pos: { '3': [[128, 128], [384, 128], [128, 384]] },
            },
        },
    };
    return { ...unsigned, mapBundleHash: computeMapBundleHash(unsigned) };
}

describe('map loader', () => {
    it('validates the envelope/hash and creates a private mutable grid', () => {
        const bundle = parseMapBundle(fixture(), 60);
        const first = instantiateMap(bundle, 'arena');
        const second = instantiateMap(bundle, 'arena');
        first.tiles[0]![0] = 1;
        assert.equal(second.tiles[0]![0], 0);
        assert.deepEqual(first.timeline[2], [[1, 0, 0]]);
    });

    it('fails startup on simulation frequency or content hash mismatch', () => {
        assert.throws(() => parseMapBundle(fixture(30), 60), MapBundleError);
        const tampered = fixture();
        tampered.maps.arena.barrier_speed = 2;
        assert.throws(() => parseMapBundle(tampered, 60), /mapBundleHash/);
    });

    it('rejects malformed MapBuilder coordinates and physics values', () => {
        const malformed = fixture();
        malformed.maps.arena.timeline['2'] = [[5, 0, 9]];
        malformed.mapBundleHash = computeMapBundleHash({
            schemaVersion: malformed.schemaVersion,
            simulationHz: malformed.simulationHz,
            tileSize: malformed.tileSize,
            maps: malformed.maps,
        });
        assert.throws(() => parseMapBundle(malformed, 60), MapBundleError);
    });
});
