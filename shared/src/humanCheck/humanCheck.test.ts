import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { leadingZeroBits, sha256 } from './sha256';
import { searchPow, verifyPow } from './pow';
import { RADIO_ROUND, SWITCH_ROUND, buildRadioRound, buildSwitchRound, checkSwitchAnswer, roundPosition } from './round';

test('순수 SHA-256은 node:crypto와 같은 값을 낸다(블록 경계 포함)', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 200]) {
        const input = randomBytes(length);
        assert.equal(Buffer.from(sha256(input)).toString('hex'), createHash('sha256').update(input).digest('hex'), `length ${length}`);
    }
});

test('앞쪽 0비트를 바이트 경계 너머까지 센다', () => {
    assert.equal(leadingZeroBits(Uint8Array.from([0, 0, 0x10, 0xff])), 19);
    assert.equal(leadingZeroBits(Uint8Array.from([0x80])), 0);
    assert.equal(leadingZeroBits(new Uint8Array(4)), 32);
});

test('찾은 counter는 검증을 통과하고, 한 비트 더 어렵게 요구하면 대부분 떨어진다', () => {
    const nonce = 'test-nonce';
    const counter = searchPow(nonce, 12, 0, 1 << 20);
    assert.notEqual(counter, null);
    assert.equal(verifyPow(nonce, 12, counter!), true);
    assert.equal(verifyPow(nonce, 12, -1), false);
    assert.equal(verifyPow(nonce, 12, 1.5), false);
});

test('라스트 세컨드 스위치: 시간 창 동안 사거리 안에는 정답만 있다', () => {
    for (let seed = 1; seed <= 400; seed++) {
        const round = buildSwitchRound(seed * 2654435761);
        const all = [round.selfSlot, round.tagger.slot, ...round.runners.map((r) => r.slot)];
        assert.equal(new Set(all).size, all.length, 'slots are distinct');
        assert.ok(round.runners.some((r) => r.slot === round.target));
        for (let t = round.openAt - SWITCH_ROUND.graceMs; t <= round.caughtAt + SWITCH_ROUND.graceMs; t += 25) {
            for (const runner of round.runners) {
                const { r } = roundPosition(runner.keys, t);
                if (runner.slot === round.target) assert.ok(r < SWITCH_ROUND.range - 3, `seed ${seed} target outside at ${t}`);
                else assert.ok(r > SWITCH_ROUND.range + 6, `seed ${seed} decoy ${runner.slot} inside at ${t}`);
            }
            if (t >= round.openAt) assert.ok(roundPosition(round.tagger.keys, t).r <= SWITCH_ROUND.approach, 'tagger is in approach range');
        }
        // 미끼가 실제로 일찍 사거리에 들어온다 — 서두르는 사람이 틀릴 자리가 있어야 한다.
        const early = round.runners.some((runner) => runner.slot !== round.target
            && [500, 700, 900].some((t) => roundPosition(runner.keys, t).r < SWITCH_ROUND.range));
        assert.ok(early, `seed ${seed} has an early bait`);
    }
});

test('라스트 세컨드 스위치 판정은 번호와 시각을 둘 다 본다', () => {
    const round = buildSwitchRound(42);
    const wrong = round.runners.find((r) => r.slot !== round.target)!.slot;
    assert.equal(checkSwitchAnswer(round, round.target, round.openAt + 100), 'ok');
    assert.equal(checkSwitchAnswer(round, round.target, round.openAt - 600), 'early');
    assert.equal(checkSwitchAnswer(round, round.target, round.caughtAt + 600), 'late');
    assert.equal(checkSwitchAnswer(round, wrong, round.openAt + 100), 'wrong');
    assert.deepEqual(buildSwitchRound(42), round, 'same seed, same scene');
});

test('관전석 무전: 마지막 턴에 사거리 안은 정답 하나, 처음에는 미끼가 사거리 안이다', () => {
    for (let seed = 1; seed <= 400; seed++) {
        const round = buildRadioRound(seed * 40503);
        const distance = new Map<number, number>();
        const insideAfter: number[][] = [];
        for (const turn of round.turns) {
            for (const move of turn.moves) distance.set(move.slot, move.distance);
            insideAfter.push([...distance].filter(([, d]) => d <= RADIO_ROUND.range).map(([slot]) => slot));
        }
        assert.deepEqual(insideAfter.at(-1), [round.target]);
        assert.ok(insideAfter[0]!.length === 1 && insideAfter[0]![0] !== round.target);
        assert.equal(round.turns.at(-1)!.tagger, RADIO_ROUND.range);
    }
});
