/**
 * 입력에서 목표 속도를 만들고 후보 위치를 계산한다.
 *
 * 클라이언트가 보낸 좌표, 속도, 이동 거리는 존재하지 않는다. 입력 패킷에 그런 필드가 아예 없다.
 * 여기서 만들어지는 속도가 그 플레이어의 유일한 속도다.
 */

import { movementVector, type InputState } from 'shared';
import { GAMEPLAY } from '../config/gameplay';
import { SIMULATION_STEP_MS } from '../config/network';
import { currentSpeed } from './effects';
import type { PlayerState, ResolvedInput } from './world';

/**
 * 입력 상태를 이번 tick의 이동 의도로 확정한다.
 *
 * 좌우/상하 동시 입력 처리와 대각선 정규화는 `shared`의 `movementVector`가 한다.
 * 서버와 클라이언트 예측이 반드시 같은 함수를 써야 하는 계산이라 여기 복사하지 않는다.
 */
export function resolveInput(state: InputState, playerId: number): ResolvedInput {
    const v = movementVector(state);
    return {
        playerId,
        moveX: v.x,
        moveY: v.y,
        heldActions: state.heldActions,
        lastProcessedSequence: state.sequence,
    };
}

/** 연결이 끊긴 플레이어의 입력. 마지막 방향으로 계속 미끄러지면 안 된다. */
export function neutralInput(playerId: number, lastProcessedSequence: number): ResolvedInput {
    return { playerId, moveX: 0, moveY: 0, heldActions: 0, lastProcessedSequence };
}



/**
 * 속도를 갱신하고 후보 위치를 만든다. 아직 충돌을 보지 않은 위치다.
 *
 * `facing`은 입력이 있을 때만 갱신한다. 손을 떼면 마지막으로 바라보던 방향을 유지한다.
 * 멈출 때마다 방향이 초기화되면 화면에서 캐릭터가 홱 돌아간다.
 */
export function integrate(player: PlayerState, input: ResolvedInput): { x: number; y: number } {
    const speed = currentSpeed(player);
    player.vx = input.moveX * speed;
    player.vy = input.moveY * speed;

    if (input.moveX !== 0 || input.moveY !== 0) {
        player.facingX = input.moveX;
        player.facingY = input.moveY;
    }

    const dt = SIMULATION_STEP_MS / 1000;
    return { x: player.x + player.vx * dt, y: player.y + player.vy * dt };
}

/**
 * 한 tick 이동량이 크면 몇 조각으로 나눌지. 대시처럼 순간 이동량이 큰 경우 벽을 그냥 통과한다.
 *
 * 정확한 swept circle 대신 sub-step을 쓰는 이유는, 이동량이 타일 크기보다 훨씬 작은 평상시에
 * 항상 1을 반환해 추가 비용이 없기 때문이다. 대시가 들어올 때만 계산이 늘어난다.
 */
export function substepCount(fromX: number, fromY: number, toX: number, toY: number): number {
    const distance = Math.hypot(toX - fromX, toY - fromY);
    return Math.max(1, Math.ceil(distance / GAMEPLAY.MAX_SUBSTEP_DISTANCE_PX));
}
