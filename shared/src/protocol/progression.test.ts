import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROGRESSION, levelFromXp, matchXp, matchXpBreakdown } from './progression';

test('XP는 참가·승리·아웃·스위치 성공·생존시간을 합친 값이다', () => {
    assert.equal(matchXp({ won: false, tagCount: 0, switchSuccess: 0, survivedMs: 0 }), PROGRESSION.XP_PER_MATCH);
    assert.equal(
        matchXp({ won: true, tagCount: 2, switchSuccess: 1, survivedMs: 60_000 }),
        PROGRESSION.XP_PER_MATCH
        + PROGRESSION.XP_PER_WIN
        + 2 * PROGRESSION.XP_PER_TAG
        + PROGRESSION.XP_PER_SWITCH_SUCCESS
        + PROGRESSION.XP_PER_SURVIVED_MINUTE,
    );
});

test('생존 XP는 초 단위로 비례한다', () => {
    // 59초와 60초 사이에 절벽이 있으면 마지막 1초를 버티려는 이상한 플레이가 생긴다.
    const base = { won: false, tagCount: 0, switchSuccess: 0 };
    const half = matchXp({ ...base, survivedMs: 30_000 }) - PROGRESSION.XP_PER_MATCH;
    assert.equal(half, Math.floor(PROGRESSION.XP_PER_SURVIVED_MINUTE / 2));
    assert.ok(matchXp({ ...base, survivedMs: 45_000 }) > matchXp({ ...base, survivedMs: 44_000 })
        || matchXp({ ...base, survivedMs: 50_000 }) > matchXp({ ...base, survivedMs: 44_000 }));
});

test('생존 XP에는 상한이 있다', () => {
    // 자기장이 멈춘 방에서 가만히 서 있는 것이 최고 효율이 되면 안 된다.
    const base = { won: false, tagCount: 0, switchSuccess: 0 };
    const capped = matchXp({ ...base, survivedMs: PROGRESSION.XP_SURVIVAL_CAP_MS });
    assert.equal(matchXp({ ...base, survivedMs: PROGRESSION.XP_SURVIVAL_CAP_MS * 10 }), capped);
});

test('생존시간을 안 주면 0으로 본다', () => {
    // 이 항목이 생기기 전에 쓰인 호출부가 조용히 남의 XP를 깎지 않아야 한다.
    assert.equal(matchXp({ won: false, tagCount: 0, switchSuccess: 0 }), PROGRESSION.XP_PER_MATCH);
});

test('음수 통계가 XP를 깎지 못한다', () => {
    // 인게임 서버가 보내는 값이지만, 결과는 파일과 스트림을 거쳐 온다. 음수가 통과하면
    // 한 판으로 남의 XP를 0으로 되돌릴 수 있다.
    assert.equal(matchXp({ won: false, tagCount: -5, switchSuccess: -5, survivedMs: -60_000 }), PROGRESSION.XP_PER_MATCH);
    for (const survivedMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(matchXp({ won: false, tagCount: 0, switchSuccess: 0, survivedMs }), PROGRESSION.XP_PER_MATCH);
    }
});

test('내역의 합은 총합과 같다', () => {
    const breakdown = matchXpBreakdown({ won: true, tagCount: 3, switchSuccess: 2, survivedMs: 125_000 });
    assert.equal(
        breakdown.played + breakdown.win + breakdown.tags + breakdown.switches + breakdown.survival,
        breakdown.total,
    );
    assert.equal(breakdown.win, PROGRESSION.XP_PER_WIN);
    assert.equal(breakdown.tags, 3 * PROGRESSION.XP_PER_TAG);
});

test('레벨은 1부터 시작하고 누적 XP에서 센다', () => {
    assert.deepEqual(levelFromXp(0), { level: 1, xpIntoLevel: 0, xpForNextLevel: 100 });
    assert.deepEqual(levelFromXp(99), { level: 1, xpIntoLevel: 99, xpForNextLevel: 100 });
    // 100을 채우면 2레벨. 다음 비용은 150이다.
    assert.deepEqual(levelFromXp(100), { level: 2, xpIntoLevel: 0, xpForNextLevel: 150 });
    assert.deepEqual(levelFromXp(250), { level: 3, xpIntoLevel: 0, xpForNextLevel: 200 });
});

test('다음 레벨 비용은 레벨마다 늘어난다', () => {
    let previous = 0;
    let xp = 0;
    for (let level = 1; level <= 30; level += 1) {
        const progress = levelFromXp(xp);
        assert.equal(progress.level, level);
        assert.ok(progress.xpForNextLevel > previous, `레벨 ${level}의 비용이 줄었다`);
        previous = progress.xpForNextLevel;
        xp += progress.xpForNextLevel;
    }
});

test('쓰레기 XP 값은 1레벨로 떨어진다', () => {
    // `users.stats`는 jsonb다. 컬럼 안에 무엇이 들어 있든 화면에 NaN이 나가면 안 된다.
    for (const xp of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(levelFromXp(xp).level, 1);
    }
});
