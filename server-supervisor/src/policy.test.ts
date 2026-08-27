import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GameServerHeartbeat } from 'shared';
import { DEFAULT_POLICY, decideScaling, type ScalingInput } from './policy';

function server(serverId: string, overrides: Partial<GameServerHeartbeat> = {}): GameServerHeartbeat {
    return {
        serverId,
        buildVersion: 'build',
        protocolVersion: 2,
        rulesVersion: 'rules',
        mapBundleHash: 'hash',
        waitingRooms: 0,
        playingRooms: 0,
        connections: 0,
        loopLagMs: 0,
        draining: false,
        internalAddress: 'http://127.0.0.1:4000',
        updatedAt: 0,
        ...overrides,
    };
}

const input = (overrides: Partial<ScalingInput> = {}): ScalingInput => ({
    servers: [],
    starting: 0,
    now: 1_000_000,
    lastActionAt: null,
    policy: DEFAULT_POLICY,
    ...overrides,
});

test('최소 대수를 못 채우면 쿨다운을 무시하고 띄운다', () => {
    // 가용성 문제지 부하 문제가 아니다. 서버가 0대면 아무도 방을 못 만든다.
    const action = decideScaling(input({ servers: [], lastActionAt: 1_000_000 - 1 }));
    assert.equal(action.kind, 'up');
});

test('한가하면 아무것도 안 한다', () => {
    const action = decideScaling(input({ servers: [server('a', { playingRooms: 2 })] }));
    assert.equal(action.kind, 'hold');
});

test('평균 부하가 높으면 늘린다', () => {
    const action = decideScaling(input({ servers: [server('a', { playingRooms: 9 })] }));
    assert.equal(action.kind, 'up');
});

test('상한에 닿으면 더 안 늘린다', () => {
    const busy = Array.from({ length: 4 }, (_, i) => server(`s${i}`, { playingRooms: 20 }));
    assert.equal(decideScaling(input({ servers: busy })).kind, 'hold');
});

test('쿨다운 중에는 움직이지 않는다', () => {
    const action = decideScaling(input({
        servers: [server('a', { playingRooms: 9 })],
        lastActionAt: 1_000_000 - DEFAULT_POLICY.cooldownMs + 1,
    }));
    assert.equal(action.kind, 'hold');
});

test('기동 중인 프로세스를 부하 0으로 세지 않는다', () => {
    // 세어 버리면 늘리자마자 평균이 뚝 떨어져 방금 띄운 것을 다시 재운다.
    const action = decideScaling(input({ servers: [server('a', { playingRooms: 9 })], starting: 1 }));
    assert.equal(action.kind, 'hold');
});

test('한가하면 가장 조용한 서버를 재운다', () => {
    const action = decideScaling(input({
        servers: [server('a', { playingRooms: 1 }), server('b', { playingRooms: 0 })],
    }));
    assert.deepEqual(
        action.kind === 'down' ? action.serverId : action.kind,
        'b',
    );
});

test('최소 대수까지 내려가면 더 안 줄인다', () => {
    const action = decideScaling(input({ servers: [server('a')] }));
    assert.equal(action.kind, 'hold');
});

test('이미 재우는 중이면 또 재우지 않는다', () => {
    // 여러 대를 동시에 drain하면 남은 서버로 방이 몰리고 그 순간 다시 늘려야 한다.
    const action = decideScaling(input({
        servers: [server('a'), server('b'), server('c', { draining: true })],
    }));
    assert.equal(action.kind, 'hold');
});

test('draining 서버는 용량으로 세지 않는다', () => {
    // 새 방을 못 받는 서버를 용량으로 세면, 정작 받을 곳이 없는데 아무것도 안 늘린다.
    const action = decideScaling(input({
        servers: [server('a', { playingRooms: 9 }), server('b', { draining: true, playingRooms: 0 })],
    }));
    assert.equal(action.kind, 'up', 'draining을 세서 평균이 희석됐다');
});

test('올리는 문턱과 내리는 문턱이 겹치지 않는다', () => {
    // 겹치면 늘렸다 줄였다를 왕복한다. 축소는 drain을 거쳐 몇 분이 걸리므로 그 대가가 크다.
    assert.ok(DEFAULT_POLICY.scaleDownLoad < DEFAULT_POLICY.scaleUpLoad / 2);

    // 한 대 늘린 직후의 평균이 내리는 문턱보다 높아야 곧바로 되돌리지 않는다.
    const loadJustAboveUp = DEFAULT_POLICY.scaleUpLoad + 0.1;
    const afterScaleUp = loadJustAboveUp / 2;
    assert.ok(afterScaleUp > DEFAULT_POLICY.scaleDownLoad, `늘린 직후 평균 ${afterScaleUp}가 곧바로 축소 대상이 된다`);
});
