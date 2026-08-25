import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RoomMode } from 'shared';
import {
    computeMapBundleHash,
    instantiateMap,
    isPlayableMap,
    MapBundleError,
    parseMapBundle,
    playableMapIds,
} from './map-loader';

function fixture(simulationHz = 60) {
    const unsigned = {
        schemaVersion: 3,
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
            dojo: {
                size: 2,
                barrier_speed: 1,
                training_only: true,
                initial_map: [[0, 1], [2, 3]],
                timeline: {},
                start_pos: {},
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

    it('훈련장 맵은 경기 방의 선택지에서 빠지고 훈련장에서만 보인다', () => {
        const bundle = parseMapBundle(fixture(), 60);

        assert.deepEqual(playableMapIds(bundle, RoomMode.Match), ['arena']);
        assert.deepEqual(playableMapIds(bundle, RoomMode.Training), ['arena', 'dojo']);
        // 목록과 낱개 검사가 같은 규칙을 봐야 "고를 수는 있는데 누르면 안 되는" 맵이 안 생긴다.
        assert.equal(isPlayableMap(bundle, 'dojo', RoomMode.Match), false);
        assert.equal(isPlayableMap(bundle, 'dojo', RoomMode.Training), true);
        assert.equal(isPlayableMap(bundle, 'nowhere', RoomMode.Training), false);
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
