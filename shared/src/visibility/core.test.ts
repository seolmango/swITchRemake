import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TilePhysics } from '../protocol/constants';
import { computeVisibility, isConcealed, VISIBILITY } from './core';
import { packVisibleMask, unpackVisibleMask, type VisibilityActor, type VisibilityWorld } from './types';

const TILE = 256;
const RADIUS = 102;

/** `.` 바닥 · `#` 벽 · `b` 수풀 · `g` 연막 */
function world(rows: readonly string[], players: VisibilityActor[]): VisibilityWorld {
    const tiles = rows.map((row) => [...row].map((ch) => {
        switch (ch) {
            case '#': return TilePhysics.Wall;
            case 'b': return TilePhysics.Bush;
            case 'g': return TilePhysics.Gas;
            default: return TilePhysics.Floor;
        }
    }));
    return { cols: tiles[0]?.length ?? 0, rows: tiles.length, tileSize: TILE, tiles, players };
}

function at(playerId: number, tileX: number, tileY: number, offset = { x: 0, y: 0 }): VisibilityActor {
    return {
        playerId,
        x: (tileX + 0.5) * TILE + offset.x,
        y: (tileY + 0.5) * TILE + offset.y,
        radius: RADIUS,
        sightRange: 16 * TILE,
        alive: true,
    };
}

const OPEN = ['.........', '.........', '.........', '.........', '.........'];

test('트인 곳의 플레이어는 서로 보인다', () => {
    const w = world(OPEN, [at(1, 1, 2), at(2, 3, 2)]);
    const r = computeVisibility(w, 1);
    assert.deepEqual([...r.visiblePlayerIds].sort(), [1, 2]);
    assert.deepEqual(r.obscuredPlayerIds, []);
});

test('수풀 한가운데 있으면 은신이다', () => {
    const w = world(['bbb', 'bbb', 'bbb'], [at(1, 1, 1)]);
    assert.equal(isConcealed(w, w.players[0]!), true);
});

test('몸이 수풀 밖으로 조금이라도 삐져나오면 은신이 아니다', () => {
    // 타일 경계에서 반지름만큼 안 들어온 위치.
    const w = world(['.b.', '.b.', '.b.'], [at(1, 1, 1, { x: TILE / 2 - RADIUS + 1, y: 0 })]);
    assert.equal(isConcealed(w, w.players[0]!), false, '수풀 가장자리에 걸쳤는데 은신 처리됐다');
});

test('연막도 수풀과 같이 은신 타일이다', () => {
    const w = world(['ggg', 'ggg', 'ggg'], [at(1, 1, 1)]);
    assert.equal(isConcealed(w, w.players[0]!), true);
});

test('맵 밖에 걸치면 은신할 수 없다', () => {
    const w = world(['bb', 'bb'], [at(1, 0, 0, { x: -TILE / 2, y: 0 })]);
    assert.equal(isConcealed(w, w.players[0]!), false);
});

test('멀리 있는 은신 플레이어는 아예 전송 대상이 아니다', () => {
    const rows = [
        '.........',
        '.........',
        '....bbb..',
        '....bbb..',
        '....bbb..',
        '.........',
    ];
    const w = world(rows, [at(1, 0, 0), at(2, 5, 3)]);
    const r = computeVisibility(w, 1);
    assert.ok(!r.visiblePlayerIds.includes(2), '숨은 사람이 먼 거리에서 보였다');
});

test('가까이 붙으면 은신한 플레이어도 보이고 obscured로 표시된다', () => {
    const rows = [
        '.........',
        '.........',
        '....bbb..',
        '....bbb..',
        '....bbb..',
        '.........',
    ];
    const w = world(rows, [at(1, 4, 2), at(2, 5, 3)]);
    const r = computeVisibility(w, 1);
    assert.ok(r.visiblePlayerIds.includes(2), '바로 옆인데 안 보였다');
    assert.ok(r.obscuredPlayerIds.includes(2), 'obscured 표시가 빠졌다');
});

test('근접 노출 창은 레거시와 같은 21칸이다', () => {
    let count = 0;
    const reach = VISIBILITY.REVEAL_AXIS - 1;
    for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
            if (Math.abs(dx) + Math.abs(dy) < VISIBILITY.REVEAL_MANHATTAN) count++;
        }
    }
    assert.equal(count, 21);
});

test('자기 자신은 수풀에 있어도 보이고 obscured로 표시된다', () => {
    const w = world(['bbb', 'bbb', 'bbb'], [at(1, 1, 1)]);
    const r = computeVisibility(w, 1);
    assert.deepEqual(r.visiblePlayerIds, [1]);
    assert.deepEqual(r.obscuredPlayerIds, [1], '내가 숨어 있다는 걸 나는 알아야 한다');
});

test('시야는 원이 아니라 16:9 사각형이다', () => {
    const wide = world(OPEN, [at(1, 0, 0), at(2, 0, 0)]);
    const viewer = wide.players[0]!;
    const target = wide.players[1]!;

    // 가로로는 시야 폭의 절반 바로 안쪽
    target.x = viewer.x + viewer.sightRange / 2 - 1;
    target.y = viewer.y;
    assert.ok(computeVisibility(wide, 1).visiblePlayerIds.includes(2), '가로 끝이 잘렸다');

    // 같은 거리를 세로로 두면 화면 밖이다
    target.x = viewer.x;
    target.y = viewer.y + viewer.sightRange / 2 - 1;
    assert.ok(!computeVisibility(wide, 1).visiblePlayerIds.includes(2), '세로가 가로만큼 넓으면 안 된다');
});

test('벽은 시야를 막지 않는다', () => {
    // 레거시와 같은 동작이다. 벽 차폐를 넣으면 은신 시스템과 역할이 겹친다.
    const w = world(['.#.', '.#.', '.#.'], [at(1, 0, 1), at(2, 2, 1)]);
    assert.ok(computeVisibility(w, 1).visiblePlayerIds.includes(2));
});

test('탈락한 플레이어는 전송 대상이 아니다', () => {
    const w = world(OPEN, [at(1, 1, 2), { ...at(2, 3, 2), alive: false }]);
    assert.deepEqual(computeVisibility(w, 1).visiblePlayerIds, [1]);
});

test('근처 은신 타일만 비치게 보낸다', () => {
    const rows = [
        'b........',
        '.........',
        '...bb....',
        '...bb....',
        '.........',
    ];
    const w = world(rows, [at(1, 3, 2)]);
    const alphas = computeVisibility(w, 1).tileAlphas;

    assert.ok(alphas.some((t) => t.x === 3 && t.y === 2), '발밑 수풀이 빠졌다');
    assert.ok(!alphas.some((t) => t.x === 0 && t.y === 0), '먼 수풀까지 보내면 트래픽만 늘고 정보가 샌다');
    assert.ok(alphas.every((t) => t.alpha > 0 && t.alpha < 1));
});

test('없는 뷰어를 물으면 빈 결과가 나온다', () => {
    const w = world(OPEN, [at(1, 1, 1)]);
    const r = computeVisibility(w, 99);
    assert.deepEqual(r.visiblePlayerIds, []);
    assert.deepEqual(r.tileAlphas, []);
});

test('시야 bitmask 왕복', () => {
    assert.equal(packVisibleMask([0, 3, 7]), 0b10001001);
    assert.deepEqual(unpackVisibleMask(0b10001001), [0, 3, 7]);
    assert.deepEqual(unpackVisibleMask(packVisibleMask([1, 2])), [1, 2]);
});

test('같은 입력에 항상 같은 결과를 낸다', () => {
    const rows = ['..bb..', '..bb..', '......'];
    const build = () => world(rows, [at(1, 0, 0), at(2, 2, 0), at(3, 5, 2)]);
    const a = JSON.stringify(computeVisibility(build(), 1));
    const b = JSON.stringify(computeVisibility(build(), 1));
    assert.equal(a, b);
});
