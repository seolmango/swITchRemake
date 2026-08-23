/**
 * 시야 코어의 입출력 계약.
 *
 * 실제 판정 알고리즘(`core.ts`)은 C 묶음(시뮬레이션)에서 채운다. 여기서 형태만 먼저 고정하는 이유는
 * 두 가지다.
 *
 *  1. 서버의 스냅샷 검열과 리플레이의 개인 시점 재구성이 **같은 함수**를 써야 한다. 두 벌로 관리하면
 *     시간이 지나며 갈라지고, 갈라지는 순간 리플레이는 "그 사람이 실제로 본 화면"이 아니게 된다.
 *  2. 이 함수는 소켓, Phaser, 방 객체를 모르는 순수 함수여야 한다. 경계를 나중에 그으면 이미 얽힌
 *     코드를 풀어야 한다.
 *
 * 시야 알고리즘이 클라이언트 번들에 들어가는 것은 위험하지 않다. 보안은 알고리즘 비공개가 아니라
 * **보이지 않는 플레이어의 좌표를 애초에 보내지 않는 것**에서 나온다.
 */

import type { TilePhysics } from '../protocol/constants';

/** 시야 계산에 필요한 만큼의 월드 상태. 권위 프레임에서 뽑아낸다. */
export interface VisibilityWorld {
    cols: number;
    rows: number;
    tileSize: number;
    /** [row][col]. */
    tiles: readonly (readonly TilePhysics[])[];
    players: readonly VisibilityActor[];
}

export interface VisibilityActor {
    playerId: number;
    /** 월드 px. */
    x: number;
    y: number;
    radius: number;
    /** 시야 사거리(px). 플레이어마다 다를 수 있다. */
    sightRange: number;
    alive: boolean;
}

export interface VisibilityResult {
    /** 이 뷰어에게 보내도 되는 플레이어. 여기 없는 사람은 스냅샷에서 통째로 빠진다. */
    visiblePlayerIds: readonly number[];
    /** 보이지만 은신 중이라 반투명하게 그려야 하는 플레이어. `visiblePlayerIds`의 부분집합이다. */
    obscuredPlayerIds: readonly number[];
    /** 이 뷰어 기준으로 비치는 은신 타일. 목록에 없는 타일은 불투명이다. 누적이 아니라 전량 교체다. */
    tileAlphas: readonly { x: number; y: number; alpha: number }[];
}

/**
 * 시야 판정. 같은 입력에 항상 같은 결과를 내야 한다.
 *
 * 관전자와 리플레이 전지적 모드는 이 함수를 호출하지 않고 전원을 그대로 쓴다.
 * 즉 "검열하지 않는다"는 판단은 호출하는 쪽의 책임이고, 이 함수는 검열 여부를 스스로 정하지 않는다.
 */
export type ComputeVisibility = (world: VisibilityWorld, viewerId: number) => VisibilityResult;

/**
 * 플레이어 최대 8명이라 뷰어 하나의 판정 결과가 1바이트에 들어간다.
 * 리플레이는 스냅샷 tick마다 이 bitmask를 남겨, 재생 시 코어 버전이 달라졌는지 검출한다.
 */
export function packVisibleMask(visiblePlayerIds: readonly number[]): number {
    let mask = 0;
    for (const id of visiblePlayerIds) {
        if (id >= 0 && id < 8) mask |= 1 << id;
    }
    return mask;
}

export function unpackVisibleMask(mask: number): number[] {
    const out: number[] = [];
    for (let id = 0; id < 8; id++) {
        if ((mask & (1 << id)) !== 0) out.push(id);
    }
    return out;
}
