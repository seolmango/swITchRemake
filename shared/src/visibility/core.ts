/**
 * 시야 판정. 서버의 스냅샷 검열과 리플레이의 개인 시점 재구성이 이 함수 하나를 공유한다.
 *
 * 순수 함수다. 소켓, Phaser, 방 객체를 모른다. 같은 입력에 항상 같은 결과를 낸다.
 *
 * ## 모델
 *
 * 레거시(`legacy/public/script/RenderingManager.js:285-327`)의 판정을 서버로 옮긴 것이다.
 * 다만 레거시는 **클라이언트가** 이 계산을 했고, 그래서 모든 플레이어 좌표가 이미 클라이언트에
 * 도착해 있었다. 렌더링만 안 했을 뿐 메모리를 뜯으면 전부 보였다. 이 함수를 서버에서 돌리고
 * 결과에 없는 플레이어를 아예 전송하지 않는 것이 그 취약점을 없애는 방법이다.
 *
 * 판정은 세 단계다.
 *
 *  1. **뷰포트 컬링** — 시야는 원이 아니라 16:9 사각형이다. 화면에 안 들어오면 안 보낸다.
 *     원으로 하면 화면 구석에 있어야 할 플레이어가 사라진다.
 *  2. **은신** — 플레이어 원이 은신 타일(수풀·연막) 안에 완전히 들어가 있으면 숨은 것이다.
 *     한 픽셀이라도 밖으로 삐져나오면 숨은 게 아니다.
 *  3. **근접 노출** — 숨어 있어도 아주 가까이 붙으면 보인다. 레거시의 21칸 창을 그대로 쓴다.
 *     이게 없으면 수풀에 들어간 순간 완전 무적이 된다.
 *
 * **벽은 시야를 막지 않는다.** 레거시도 그랬고, 벽 차폐를 넣으면 은신 시스템과 역할이 겹친다.
 */

import { TilePhysics } from '../protocol/constants';
import type { VisibilityActor, VisibilityResult, VisibilityWorld } from './types';

/** 이 값들이 바뀌면 `VISIBILITY_CORE_VERSION`을 올린다. 판정 결과가 달라지기 때문이다. */
export const VISIBILITY = Object.freeze({
    /** 시야 사각형의 세로/가로 비. 16:9. */
    ASPECT: 9 / 16,
    /** 근접 노출 창. 레거시의 `|dx|+|dy| < 4 && |dx| < 3 && |dy| < 3`과 같다. 타일 21칸. */
    REVEAL_MANHATTAN: 4,
    REVEAL_AXIS: 3,
    /** 근접 창 안의 은신 타일을 이만큼 비치게 한다. 0이면 완전 투명. */
    NEARBY_CONCEALMENT_ALPHA: 0.45,
});

function isConcealmentTile(physics: TilePhysics | undefined): boolean {
    return physics === TilePhysics.Bush || physics === TilePhysics.Gas;
}

/**
 * 원이 타일 AABB와 겹치는가. closest point 방식이라 모서리 충돌도 같은 식으로 처리된다.
 * 벽 충돌 판정과 같은 계산이며, 여기서는 "은신 타일이 아닌 곳에 몸이 걸쳤는가"를 볼 때 쓴다.
 */
function circleOverlapsTile(cx: number, cy: number, r: number, tx: number, ty: number, size: number): boolean {
    const left = tx * size;
    const top = ty * size;
    const nearestX = Math.max(left, Math.min(cx, left + size));
    const nearestY = Math.max(top, Math.min(cy, top + size));
    const dx = cx - nearestX;
    const dy = cy - nearestY;
    return dx * dx + dy * dy < r * r;
}

/**
 * 플레이어가 은신 상태인가.
 *
 * 원 전체가 은신 타일 위에 있어야 한다. 원이 걸치는 타일 중 하나라도 은신 타일이 아니면 노출이다.
 * 레거시는 이 판정을 인접 타일 조건 분기 열댓 개로 근사했는데, 원-타일 겹침으로 바꾸면 같은 의도를
 * 훨씬 짧게 표현할 수 있고 모서리 케이스가 저절로 맞는다.
 *
 * 맵 밖은 은신 타일이 아니다. 맵 경계에 붙어 있으면 숨을 수 없다.
 */
export function isConcealed(world: VisibilityWorld, actor: VisibilityActor): boolean {
    const { tileSize, cols, rows, tiles } = world;
    const minTx = Math.floor((actor.x - actor.radius) / tileSize);
    const maxTx = Math.floor((actor.x + actor.radius) / tileSize);
    const minTy = Math.floor((actor.y - actor.radius) / tileSize);
    const maxTy = Math.floor((actor.y + actor.radius) / tileSize);

    for (let ty = minTy; ty <= maxTy; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
            const outside = tx < 0 || ty < 0 || tx >= cols || ty >= rows;
            const physics = outside ? undefined : tiles[ty]?.[tx];
            if (isConcealmentTile(physics)) continue;
            // 은신 타일이 아닌 칸이다. 몸이 여기 걸쳐 있으면 숨은 게 아니다.
            if (circleOverlapsTile(actor.x, actor.y, actor.radius, tx, ty, tileSize)) return false;
        }
    }
    return true;
}

/** 레거시의 21칸 창. 타일 인덱스 기준이라 픽셀 거리가 아니라 칸 수로 센다. */
function withinRevealWindow(world: VisibilityWorld, a: VisibilityActor, b: VisibilityActor): boolean {
    const ax = Math.floor(a.x / world.tileSize);
    const ay = Math.floor(a.y / world.tileSize);
    const bx = Math.floor(b.x / world.tileSize);
    const by = Math.floor(b.y / world.tileSize);
    const dx = Math.abs(ax - bx);
    const dy = Math.abs(ay - by);
    return dx + dy < VISIBILITY.REVEAL_MANHATTAN && dx < VISIBILITY.REVEAL_AXIS && dy < VISIBILITY.REVEAL_AXIS;
}

/** 시야 사각형 안에 들어오는가. `sightRange`는 가로 폭(px)이고 세로는 16:9로 파생된다. */
function withinViewport(viewer: VisibilityActor, target: VisibilityActor): boolean {
    const halfW = viewer.sightRange / 2 + target.radius;
    const halfH = (viewer.sightRange * VISIBILITY.ASPECT) / 2 + target.radius;
    return Math.abs(target.x - viewer.x) <= halfW && Math.abs(target.y - viewer.y) <= halfH;
}

/**
 * 한 뷰어가 무엇을 보는지 계산한다.
 *
 * 관전자와 리플레이 전지적 모드는 이 함수를 부르지 않고 전원을 그대로 쓴다. 즉 "검열하지 않는다"는
 * 판단은 호출하는 쪽 책임이고, 이 함수는 검열 여부를 스스로 정하지 않는다.
 */
export function computeVisibility(world: VisibilityWorld, viewerId: number): VisibilityResult {
    const viewer = world.players.find((p) => p.playerId === viewerId);
    if (!viewer) return { visiblePlayerIds: [], obscuredPlayerIds: [], tileAlphas: [] };

    const visiblePlayerIds: number[] = [];
    const obscuredPlayerIds: number[] = [];

    for (const target of world.players) {
        if (!target.alive) continue;

        if (target.playerId === viewer.playerId) {
            // 자기 자신은 항상 보인다. 수풀 안이면 반투명으로 그려 "지금 숨어 있다"를 알려준다.
            visiblePlayerIds.push(target.playerId);
            if (isConcealed(world, target)) obscuredPlayerIds.push(target.playerId);
            continue;
        }

        if (!withinViewport(viewer, target)) continue;

        if (isConcealed(world, target)) {
            if (!withinRevealWindow(world, viewer, target)) continue;
            visiblePlayerIds.push(target.playerId);
            obscuredPlayerIds.push(target.playerId);
            continue;
        }

        visiblePlayerIds.push(target.playerId);
    }

    return { visiblePlayerIds, obscuredPlayerIds, tileAlphas: nearbyConcealmentTiles(world, viewer) };
}

/**
 * 뷰어 근처의 은신 타일을 비치게 만든다. 목록에 없는 타일은 불투명이며, 누적이 아니라 전량 교체다.
 *
 * 근접 노출 창과 같은 범위를 쓴다. 숨은 사람이 보이기 시작하는 거리와 수풀이 비치기 시작하는 거리가
 * 다르면 "분명 보이는데 수풀에 가려 안 보이는" 상태가 생긴다.
 */
function nearbyConcealmentTiles(
    world: VisibilityWorld,
    viewer: VisibilityActor,
): { x: number; y: number; alpha: number }[] {
    const out: { x: number; y: number; alpha: number }[] = [];
    const vx = Math.floor(viewer.x / world.tileSize);
    const vy = Math.floor(viewer.y / world.tileSize);
    const reach = VISIBILITY.REVEAL_AXIS - 1;

    for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
            if (Math.abs(dx) + Math.abs(dy) >= VISIBILITY.REVEAL_MANHATTAN) continue;
            const tx = vx + dx;
            const ty = vy + dy;
            if (tx < 0 || ty < 0 || tx >= world.cols || ty >= world.rows) continue;
            if (!isConcealmentTile(world.tiles[ty]?.[tx])) continue;
            out.push({ x: tx, y: ty, alpha: VISIBILITY.NEARBY_CONCEALMENT_ALPHA });
        }
    }
    return out;
}
