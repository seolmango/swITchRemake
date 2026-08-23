/**
 * 벽과 자기장 충돌. 플레이어는 원, 벽 타일은 axis-aligned box로 취급한다.
 *
 * 레거시는 축별 clamp 뒤 모서리를 따로 분기해 처리했다(`legacy/app.js:120-155`). 조건문이 스무 개
 * 넘게 늘어서 있었고 대각선 케이스가 빠지기 쉬웠다. 여기서는 원-AABB의 closest point 하나로
 * 축 벽과 모서리를 같은 식으로 처리한다.
 */

import { TilePhysics } from 'shared';
import { confineToStorm, stormRect, type StormRect } from './storm';
import type { World, WorldMap } from './world';

/** 통과할 수 없는 타일. 수풀과 연막은 시야만 가리고 이동은 막지 않는다. */
function isSolid(physics: TilePhysics | undefined): boolean {
    return physics === TilePhysics.Wall;
}

export interface Displacement {
    x: number;
    y: number;
}

/**
 * 원 하나를 맵의 벽 밖으로 밀어낸다. 이동 후보 위치 주변 타일만 조회한다.
 *
 * 침투가 가장 깊은 타일부터 처리하지 않고 순서대로 처리하면, 두 벽 사이에 낀 원이 한쪽으로만
 * 밀려 나갔다가 다시 반대쪽에 박힌다. 그래서 한 번에 하나씩 밀고 그때마다 위치를 갱신한다.
 * 타일 순회 순서는 고정(y 오름차순 → x 오름차순)이라 결과가 결정론적이다.
 */
export function resolveWallCollision(map: WorldMap, x: number, y: number, radius: number): Displacement {
    const { tileSize, cols, rows, tiles } = map;
    let px = x;
    let py = y;

    const minTx = Math.floor((px - radius) / tileSize);
    const maxTx = Math.floor((px + radius) / tileSize);
    const minTy = Math.floor((py - radius) / tileSize);
    const maxTy = Math.floor((py + radius) / tileSize);

    for (let ty = minTy; ty <= maxTy; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
            // 맵 밖은 벽으로 취급한다. 자기장이 있어 도달할 일이 없지만, 없다고 가정하면
            // 좌표가 맵 밖으로 나가는 경로가 생긴다.
            const outside = tx < 0 || ty < 0 || tx >= cols || ty >= rows;
            if (!outside && !isSolid(tiles[ty]?.[tx])) continue;

            const left = tx * tileSize;
            const top = ty * tileSize;
            const nearestX = Math.max(left, Math.min(px, left + tileSize));
            const nearestY = Math.max(top, Math.min(py, top + tileSize));

            let dx = px - nearestX;
            let dy = py - nearestY;
            let distSq = dx * dx + dy * dy;

            if (distSq >= radius * radius) continue;

            if (distSq === 0) {
                // 중심이 타일 안에 완전히 들어갔다. 방향을 정할 수 없으므로 타일 중심에서
                // 바깥으로 밀어낸다. 텔레포트나 자기장 축소로만 생길 수 있는 상황이다.
                const cxTile = left + tileSize / 2;
                const cyTile = top + tileSize / 2;
                dx = px - cxTile;
                dy = py - cyTile;
                if (dx === 0 && dy === 0) dy = -1;
                distSq = dx * dx + dy * dy;
            }

            const dist = Math.sqrt(distSq);
            const push = radius - dist;
            px += (dx / dist) * push;
            py += (dy / dist) * push;
        }
    }

    return { x: px, y: py };
}

/**
 * 벽과 자기장을 함께 해결한다. 순서가 중요하다.
 *
 * 벽을 먼저 밀고 자기장으로 clamp 한다. 반대로 하면 자기장이 밀어 넣은 위치가 다시 벽 안이 될 수
 * 있다. 자기장은 항상 맵 안쪽으로 좁아지므로 clamp가 마지막에 오는 편이 안전하다.
 *
 * 자기장 경계의 벽은 MapBuilder timeline이 이미 부숴 두었으므로, clamp 결과가 벽에 박히는 경우는
 * 정상 진행에서는 생기지 않는다.
 */
export function resolveStatic(
    map: WorldMap,
    x: number,
    y: number,
    radius: number,
    storm: StormRect,
): Displacement {
    const afterWall = resolveWallCollision(map, x, y, radius);
    return confineToStorm(afterWall.x, afterWall.y, radius, storm);
}

export function resolveStaticForWorld(world: World, x: number, y: number, radius: number): Displacement {
    return resolveStatic(world.map, x, y, radius, stormRect(world));
}

/**
 * 이 자리에 원을 그대로 놓을 수 있는가. 벽에도 걸치지 않고 자기장 안이어야 한다.
 *
 * 밀어내기와 달리 보정하지 않고 판정만 한다. 순간이동처럼 "여기 놓을 수 있나?"를 여러 후보에
 * 대해 물어봐야 하는 경우에 쓴다.
 */
export function isPositionFree(map: WorldMap, x: number, y: number, radius: number, storm: StormRect): boolean {
    if (x - radius < storm.x || x + radius > storm.x + storm.width) return false;
    if (y - radius < storm.y || y + radius > storm.y + storm.height) return false;

    const { tileSize, cols, rows, tiles } = map;
    const minTx = Math.floor((x - radius) / tileSize);
    const maxTx = Math.floor((x + radius) / tileSize);
    const minTy = Math.floor((y - radius) / tileSize);
    const maxTy = Math.floor((y + radius) / tileSize);

    for (let ty = minTy; ty <= maxTy; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
            const outside = tx < 0 || ty < 0 || tx >= cols || ty >= rows;
            if (!outside && !isSolid(tiles[ty]?.[tx])) continue;

            const left = tx * tileSize;
            const top = ty * tileSize;
            const nearestX = Math.max(left, Math.min(x, left + tileSize));
            const nearestY = Math.max(top, Math.min(y, top + tileSize));
            const dx = x - nearestX;
            const dy = y - nearestY;
            if (dx * dx + dy * dy < radius * radius) return false;
        }
    }
    return true;
}
