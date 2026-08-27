/**
 * 인게임 서버를 몇 대 돌릴지 정하는 순수 규칙.
 *
 * 프로세스도 Redis도 모른다. 그래서 "부하가 이랬을 때 무엇을 하는가"를 시간을 흘려보내지 않고
 * 시험할 수 있다 — 오토스케일에서 제일 무서운 것이 요동(flapping)인데, 그건 돌려 보면서
 * 잡기가 아주 어렵다.
 */

import type { GameServerHeartbeat } from 'shared';

export interface ScalingPolicy {
    /** 아래로 내려갈 수 없는 대수. 0으로 두면 아무도 없을 때 방을 만들 수 없다. */
    readonly minServers: number;
    readonly maxServers: number;
    /** 서버당 평균 부하가 이보다 높으면 늘린다. */
    readonly scaleUpLoad: number;
    /**
     * 서버당 평균 부하가 이보다 낮으면 줄인다.
     *
     * `scaleUpLoad`와 넉넉히 벌어져 있어야 한다. 붙여 두면 한 대 늘렸다가 평균이 내려가 바로
     * 줄이고, 줄였더니 다시 올라가 늘리는 왕복이 생긴다. 그 왕복의 대가가 이 시스템에서는
     * 특히 비싸다 — 축소는 drain을 거쳐야 해서 몇 분이 걸린다.
     */
    readonly scaleDownLoad: number;
    /** 한 번 움직인 뒤 다시 움직이기까지의 최소 간격(ms). */
    readonly cooldownMs: number;
}

export const DEFAULT_POLICY: ScalingPolicy = {
    minServers: 1,
    maxServers: 4,
    scaleUpLoad: 6,
    scaleDownLoad: 1.5,
    cooldownMs: 30_000,
};

export type ScalingAction =
    | { kind: 'hold'; reason: string }
    | { kind: 'up'; reason: string }
    | { kind: 'down'; serverId: string; reason: string };

export interface ScalingInput {
    /** 지금 살아 있는 서버들의 heartbeat. */
    readonly servers: readonly GameServerHeartbeat[];
    /** 감독자가 띄웠지만 아직 heartbeat가 안 올라온 프로세스 수. */
    readonly starting: number;
    readonly now: number;
    readonly lastActionAt: number | null;
    readonly policy: ScalingPolicy;
}

/** 매칭 서버의 배정 점수와 같은 식이다. 두 곳이 다른 기준으로 보면 서로 반대로 움직인다. */
export function serverLoad(server: GameServerHeartbeat): number {
    return server.waitingRooms + server.playingRooms + server.connections / 8 + server.loopLagMs / 1000;
}

export function decideScaling(input: ScalingInput): ScalingAction {
    const { servers, starting, now, lastActionAt, policy } = input;

    // draining 중인 서버는 새 방을 못 받는다. 용량으로 세면 "충분하다"고 착각해서, 정작 받을
    // 곳이 없는데 아무것도 안 늘린다.
    const active = servers.filter((server) => !server.draining);
    const draining = servers.length - active.length;
    const capacity = active.length + starting;

    if (capacity < policy.minServers) {
        // 최소 대수를 못 채운 것은 부하 문제가 아니라 가용성 문제다. 쿨다운을 기다리지 않는다.
        return { kind: 'up', reason: `최소 ${policy.minServers}대 미만 (지금 ${capacity}대)` };
    }

    if (lastActionAt !== null && now - lastActionAt < policy.cooldownMs) {
        return { kind: 'hold', reason: '쿨다운' };
    }

    // 아직 안 뜬 프로세스를 부하 0인 서버로 치지 않는다. 그러면 늘리자마자 평균이 뚝 떨어져
    // "이제 한가하다"고 판단하고 방금 띄운 것을 다시 재운다.
    if (starting > 0) return { kind: 'hold', reason: '기동 중인 프로세스를 기다리는 중' };

    const totalLoad = active.reduce((sum, server) => sum + serverLoad(server), 0);
    const averageLoad = active.length === 0 ? Number.POSITIVE_INFINITY : totalLoad / active.length;

    if (averageLoad > policy.scaleUpLoad && capacity < policy.maxServers) {
        return { kind: 'up', reason: `평균 부하 ${averageLoad.toFixed(1)} > ${policy.scaleUpLoad}` };
    }

    // 한 번에 한 대만 재운다. 여러 대를 동시에 drain하면 남은 서버로 방이 몰리고, 그 순간
    // 다시 늘려야 하는 상태가 된다.
    if (draining > 0) return { kind: 'hold', reason: '이미 재우는 중인 서버가 있다' };

    if (averageLoad < policy.scaleDownLoad && active.length > policy.minServers) {
        const quietest = [...active]
            .sort((a, b) => serverLoad(a) - serverLoad(b) || a.serverId.localeCompare(b.serverId))[0];
        if (quietest !== undefined) {
            return {
                kind: 'down',
                serverId: quietest.serverId,
                reason: `평균 부하 ${averageLoad.toFixed(1)} < ${policy.scaleDownLoad}`,
            };
        }
    }

    return { kind: 'hold', reason: `평균 부하 ${averageLoad.toFixed(1)}` };
}
