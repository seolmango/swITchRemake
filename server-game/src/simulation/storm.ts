/**
 * 자기장. 맵 바깥에서 안쪽으로 줄어드는 단단한 사각형 경계다.
 *
 * 데미지 구역이 아니라 **벽**이다. 그래서 "자기장 밖" 상태가 존재하지 않고, 경고 UI도 피해 표시도
 * 필요 없다. 줄어들면서 플레이어와 겹치면 안쪽으로 밀어낸다.
 *
 * MapBuilder가 tick당 inset 증가량을 미리 계산해 두므로 런타임에서는 곱셈 하나로 끝난다.
 * 매 tick 자기장 주변 벽을 검색하지 않는다 — 그 벽 파괴는 이미 timeline에 들어 있다.
 */

import type { World } from './world';

export interface StormRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * 현재 tick의 안쪽 여백(px). MapBuilder의 `barrier_speed`가 px/tick 단위다.
 *
 * MapBuilder가 시작 지연 없이 tick 1부터 줄이므로 여기서도 별도 지연을 두지 않는다.
 * 지연을 넣으면 timeline의 벽 파괴 tick과 자기장 위치가 어긋난다.
 */
export function stormInset(tick: number, barrierSpeed: number): number {
    return tick * barrierSpeed;
}

export function stormRect(world: World): StormRect {
    const inset = stormInset(world.tick, world.map.barrierSpeed);
    const mapW = world.map.cols * world.map.tileSize;
    const mapH = world.map.rows * world.map.tileSize;
    return {
        x: inset,
        y: inset,
        width: Math.max(0, mapW - inset * 2),
        height: Math.max(0, mapH - inset * 2),
    };
}

/**
 * 플레이어를 자기장 안쪽 유효 위치로 밀어넣는다. 좌표를 반환하지 않고 제자리에서 고친다.
 *
 * 자기장이 플레이어 지름보다 좁아지면 양쪽 clamp가 서로 밀어내 진동한다. 그때는 중앙에 고정한다.
 * 경기는 그 전에 끝나야 정상이지만, 끝나지 않았을 때 좌표가 튀는 것보다는 낫다.
 */
export function confineToStorm(x: number, y: number, radius: number, rect: StormRect): { x: number; y: number } {
    const minX = rect.x + radius;
    const maxX = rect.x + rect.width - radius;
    const minY = rect.y + radius;
    const maxY = rect.y + rect.height - radius;

    return {
        x: minX > maxX ? rect.x + rect.width / 2 : Math.min(Math.max(x, minX), maxX),
        y: minY > maxY ? rect.y + rect.height / 2 : Math.min(Math.max(y, minY), maxY),
    };
}
