/**
 * 플레이어 간 충돌과 밀어내기.
 *
 * 레거시에는 이 기능이 아예 없었다. 플레이어끼리 그냥 통과했다. 여기서 새로 넣는 규칙이다.
 *
 * 핵심은 **빠르게 다가온 쪽이 덜 밀린다**는 것이다. 정지한 사람을 밀치고 지나갈 수 있어야 술래가
 * 몰아붙이는 플레이가 성립한다. 반대로 둘 다 정지해 있으면 절반씩 밀려 서로 겹치지 않는다.
 */

import { GAMEPLAY } from '../config/gameplay';
import type { PlayerState } from './world';

/** 이번 tick에 실제로 접촉한 쌍. 술래 판정이 이 목록을 근거로 한다. */
export interface CollisionPair {
    a: number;
    b: number;
}

/**
 * 겹친 플레이어들을 떼어낸다. 접촉한 쌍을 반환한다.
 *
 * 모든 pair를 검사한다. 최대 8명이라 28쌍뿐이고, 인원이 늘어나는 모드가 생기면 그때 spatial hash를
 * 넣는다. 지금 넣으면 검증할 수 없는 최적화만 늘어난다.
 *
 * **pair는 항상 `playerId` 오름차순으로 처리한다.** 반복 계산은 순회 순서에 결과가 달라지므로,
 * 순서를 고정하지 않으면 같은 입력이 같은 결과를 내지 않는다. 결정론 테스트가 이걸 잡는다.
 */
export function resolvePlayerCollisions(players: readonly PlayerState[]): CollisionPair[] {
    const active = players.filter((p) => p.alive).sort((a, b) => a.playerId - b.playerId);
    const pairs: CollisionPair[] = [];

    for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
            const a = active[i]!;
            const b = active[j]!;

            let dx = b.x - a.x;
            let dy = b.y - a.y;
            const minDist = a.radius + b.radius;
            let distSq = dx * dx + dy * dy;

            if (distSq >= minDist * minDist) continue;

            pairs.push({ a: a.playerId, b: b.playerId });

            if (distSq === 0) {
                // 완전히 같은 좌표. 방향을 정할 수 없으니 id 순으로 결정론적인 축을 쓴다.
                // 무작위로 흩뿌리면 리플레이가 재현되지 않는다.
                dx = 1;
                dy = 0;
                distSq = 1;
            }

            const dist = Math.sqrt(distSq);
            const nx = dx / dist;
            const ny = dy / dist;
            const penetration = minDist - dist;

            // 상대에게 다가가는 방향의 속도 성분만 힘으로 친다. 멀어지는 중이면 0이다.
            const approachA = Math.max(0, a.vx * nx + a.vy * ny);
            const approachB = Math.max(0, b.vx * -nx + b.vy * -ny);

            const powerA = GAMEPLAY.PUSH_BASE_POWER + approachA * GAMEPLAY.PUSH_SPEED_FACTOR;
            const powerB = GAMEPLAY.PUSH_BASE_POWER + approachB * GAMEPLAY.PUSH_SPEED_FACTOR;
            const total = powerA + powerB;

            // 상대 힘에 비례해 나눈다. 힘이 센 쪽이 덜 움직인다.
            const moveA = (penetration * powerB) / total;
            const moveB = (penetration * powerA) / total;

            a.x -= nx * moveA;
            a.y -= ny * moveA;
            b.x += nx * moveB;
            b.y += ny * moveB;
        }
    }

    return pairs;
}
