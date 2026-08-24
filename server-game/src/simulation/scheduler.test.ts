import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NETWORK, SIMULATION_STEP_MS, SNAPSHOT_INTERVAL_TICKS } from '../config/network';
import { Scheduler, type SchedulerTarget } from './scheduler';
import type { AuthoritativeFrame } from './world';

function fakeTarget(id: string, stopAfter = Infinity) {
    const state = { steps: 0, publishes: 0 };
    const target: SchedulerTarget = {
        id,
        step(): AuthoritativeFrame | null {
            if (state.steps >= stopAfter) return null;
            state.steps += 1;
            return { tick: state.steps, world: {} as never, events: [], skillRejections: [] };
        },
        publish(): void {
            state.publishes += 1;
        },
    };
    return { target, state };
}

/** 가짜 시계. 실제 시간에 의존하면 테스트가 CI에서 흔들린다. */
function clock() {
    let t = 0;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test('경과 시간만큼 tick이 진행된다', () => {
    const c = clock();
    const s = new Scheduler(c.now);
    const { target, state } = fakeTarget('room-1');
    s.add(target);

    s.advance(); // 첫 호출은 기준 시각만 잡는다
    c.advance(SIMULATION_STEP_MS * 3);
    s.advance();

    assert.equal(state.steps, 3);
});

test('한 프레임이 밀려도 catch-up 상한을 넘지 않는다', () => {
    const c = clock();
    const s = new Scheduler(c.now);
    const { target, state } = fakeTarget('room-1');
    s.add(target);

    s.advance();
    // 1초가 통째로 밀렸다. 60Hz면 60 step이 밀린 셈이다.
    c.advance(1000);
    s.advance();

    assert.equal(state.steps, NETWORK.MAX_CATCHUP_STEPS, '상한을 넘어 몰아 돌면 그 프레임이 또 밀린다');
    assert.ok(s.getStats().droppedMs > 0, '버린 시간이 기록돼야 과부하를 알 수 있다');
});

test('밀린 시간을 버려도 tick은 건너뛰지 않는다', () => {
    // tick이 맵 timeline과 자기장의 기준이라, 건너뛰면 같은 경기가 부하에 따라 다르게 진행된다.
    const c = clock();
    const s = new Scheduler(c.now);
    const { target, state } = fakeTarget('room-1');
    s.add(target);

    s.advance();
    c.advance(1000);
    s.advance();
    const afterOverload = state.steps;

    c.advance(SIMULATION_STEP_MS * 2);
    s.advance();

    assert.equal(state.steps, afterOverload + 2, 'tick이 연속이어야 한다');
});

test('스냅샷은 설정된 주기에만 나간다', () => {
    const c = clock();
    const s = new Scheduler(c.now);
    const { target, state } = fakeTarget('room-1');
    s.add(target);

    s.advance();
    for (let i = 0; i < SNAPSHOT_INTERVAL_TICKS * 4; i++) {
        c.advance(SIMULATION_STEP_MS);
        s.advance();
    }

    assert.equal(state.steps, SNAPSHOT_INTERVAL_TICKS * 4);
    assert.equal(state.publishes, 4, '시뮬레이션보다 스냅샷이 드물어야 한다');
});

test('끝난 방은 스케줄러에서 빠진다', () => {
    const c = clock();
    const s = new Scheduler(c.now);
    const { target } = fakeTarget('room-1', 2);
    s.add(target);
    assert.equal(s.getStats().targets, 1);

    s.advance();
    for (let i = 0; i < 5; i++) {
        c.advance(SIMULATION_STEP_MS);
        s.advance();
    }

    assert.equal(s.getStats().targets, 0, '끝난 방이 계속 자원을 붙잡고 있으면 안 된다');
});

test('방 여러 개가 같은 tick에 함께 진행된다', () => {
    const c = clock();
    const s = new Scheduler(c.now);
    const a = fakeTarget('room-a');
    const b = fakeTarget('room-b');
    s.add(a.target);
    s.add(b.target);

    s.advance();
    c.advance(SIMULATION_STEP_MS * 3);
    s.advance();

    assert.equal(a.state.steps, 3);
    assert.equal(b.state.steps, 3);
});
