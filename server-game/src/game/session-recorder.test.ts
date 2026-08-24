import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeSnapshot } from 'shared';
import { FRAMES_PER_CHUNK } from '../replay/format';
import type { ReplayEvent, ReplayMeta, ReplayOutcome, ReplayRecorder } from '../replay/recorder';
import { stepWorld } from '../simulation/step';
import { makePlayer, makeWorld, mapFromRows } from '../simulation/testing';
import { SessionReplayRecorder } from './session-recorder';

const MAP = ['#####', '#...#', '#...#', '#####'];

function fakeRecorder(): {
    recorder: ReplayRecorder;
    frames: { tick: number; full: boolean; bytes: Uint8Array }[];
    visibilities: { tick: number; masks: Uint8Array }[];
    events: { tick: number; event: ReplayEvent }[];
    metas: ReplayMeta[];
    outcomes: ReplayOutcome[];
} {
    const frames: { tick: number; full: boolean; bytes: Uint8Array }[] = [];
    const visibilities: { tick: number; masks: Uint8Array }[] = [];
    const events: { tick: number; event: ReplayEvent }[] = [];
    const metas: ReplayMeta[] = [];
    const outcomes: ReplayOutcome[] = [];
    const recorder: ReplayRecorder = {
        begin: (meta) => metas.push(meta),
        writeFrame: (tick, bytes, full) => frames.push({ tick, full, bytes }),
        writeVisibility: (tick, masks) => visibilities.push({ tick, masks }),
        writeEvent: (tick, event) => events.push({ tick, event }),
        finish: async (outcome) => {
            outcomes.push(outcome);
            return null;
        },
        abort: () => undefined,
    };
    return { recorder, frames, visibilities, events, metas, outcomes };
}

test('스냅샷 tick마다 검열 없는 프레임과 시야 bitmask를 기록한다', () => {
    const fake = fakeRecorder();
    const roster = [{ playerId: 1, nickname: 'P1' }, { playerId: 2, nickname: 'P2' }];
    const session = new SessionReplayRecorder({ recorder: fake.recorder, roster });

    const world = makeWorld(mapFromRows(MAP), [makePlayer(1, 1, 1, { isTagger: true }), makePlayer(2, 2, 1)]);
    const frame1 = stepWorld(world, []);
    session.recordSnapshotTick(frame1);
    const frame2 = stepWorld(world, []);
    session.recordSnapshotTick(frame2);

    assert.equal(fake.frames.length, 2);
    assert.equal(fake.frames[0]!.full, true, '첫 프레임은 chunk의 시작이라 keyframe이어야 한다');
    assert.equal(fake.frames[1]!.full, false);

    const firstFrame = fake.frames[0]!;
    const decoded = decodeSnapshot(
        firstFrame.bytes.buffer.slice(firstFrame.bytes.byteOffset, firstFrame.bytes.byteOffset + firstFrame.bytes.byteLength) as ArrayBuffer,
    );
    assert.equal(decoded.players?.length, 2, '검열 없이 전원이 담겨야 한다');
    assert.ok(decoded.players?.every((p) => p.obscured === false), '리플레이 원본은 obscured가 항상 0이어야 한다');
    assert.ok(decoded.map, 'keyframe에는 맵이 실려야 한다');

    assert.equal(fake.visibilities.length, 2);
    assert.equal(fake.visibilities[0]!.masks.length, 8);
    assert.deepEqual([...fake.visibilities[0]!.masks], [0b00000011, 0b00000011, 0, 0, 0, 0, 0, 0]);
});

test(`${FRAMES_PER_CHUNK}번째 프레임마다 keyframe으로 돌아간다`, () => {
    const fake = fakeRecorder();
    const roster = [{ playerId: 1, nickname: 'P1' }];
    const session = new SessionReplayRecorder({ recorder: fake.recorder, roster });
    const world = makeWorld(mapFromRows(MAP), [makePlayer(1, 1, 1)]);

    for (let i = 0; i < FRAMES_PER_CHUNK + 1; i++) {
        const frame = stepWorld(world, []);
        session.recordSnapshotTick(frame);
    }

    assert.equal(fake.frames[0]!.full, true);
    for (let i = 1; i < FRAMES_PER_CHUNK; i++) assert.equal(fake.frames[i]!.full, false, `index ${i}는 delta여야 한다`);
    assert.equal(fake.frames[FRAMES_PER_CHUNK]!.full, true, '한 바퀴 돌면 다시 keyframe이어야 한다');
});

test('경기 종료 tick은 스냅샷 주기와 무관하게 항상 keyframe이다', () => {
    const fake = fakeRecorder();
    const session = new SessionReplayRecorder({ recorder: fake.recorder, roster: [{ playerId: 1, nickname: 'P1' }] });
    const world = makeWorld(mapFromRows(MAP), [makePlayer(1, 1, 1)]);
    const frame = stepWorld(world, []);

    session.recordSnapshotTick(frame); // 이미 keyframe(0번째)
    const frame2 = stepWorld(world, []);
    session.recordFinalFrame(frame2);

    assert.equal(fake.frames[1]!.full, true);
});

test('이벤트는 정의된 optional 필드만 옮긴다', () => {
    const fake = fakeRecorder();
    const session = new SessionReplayRecorder({ recorder: fake.recorder, roster: [] });

    session.recordEvents(10, [
        { kind: 'eliminated', playerId: 2, by: 1 },
        { kind: 'blinked', playerId: 3, fromX: 5, fromY: 6 },
        { kind: 'skillUsed', playerId: 4, slot: 2 },
    ]);

    assert.deepEqual(fake.events[0]!.event, { kind: 'eliminated', playerId: 2, by: 1 });
    assert.deepEqual(fake.events[1]!.event, { kind: 'blinked', playerId: 3, fromX: 5, fromY: 6 });
    assert.deepEqual(fake.events[2]!.event, { kind: 'skillUsed', playerId: 4, slot: 2 });
});

test('finish는 레코더의 finish를 그대로 전달한다', async () => {
    const fake = fakeRecorder();
    const session = new SessionReplayRecorder({ recorder: fake.recorder, roster: [] });
    await session.finish({ endTick: 42 });
    assert.deepEqual(fake.outcomes, [{ endTick: 42 }]);
});
