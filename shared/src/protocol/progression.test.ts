import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROGRESSION, levelFromXp, matchXp } from './progression';

test('XP는 참가·승리·아웃·스위치 성공을 합친 값이다', () => {
    assert.equal(matchXp({ won: false, tagCount: 0, switchSuccess: 0 }), PROGRESSION.XP_PER_MATCH);
    assert.equal(
        matchXp({ won: true, tagCount: 2, switchSuccess: 1 }),
        PROGRESSION.XP_PER_MATCH
        + PROGRESSION.XP_PER_WIN
        + 2 * PROGRESSION.XP_PER_TAG
        + PROGRESSION.XP_PER_SWITCH_SUCCESS,
    );
});

test('음수 통계가 XP를 깎지 못한다', () => {
    // 인게임 서버가 보내는 값이지만, 결과는 파일과 스트림을 거쳐 온다. 음수가 통과하면
    // 한 판으로 남의 XP를 0으로 되돌릴 수 있다.
    assert.equal(matchXp({ won: false, tagCount: -5, switchSuccess: -5 }), PROGRESSION.XP_PER_MATCH);
});

test('레벨은 1부터 시작하고 누적 XP에서 센다', () => {
    assert.deepEqual(levelFromXp(0), { level: 1, xpIntoLevel: 0, xpForNextLevel: 100 });
    assert.deepEqual(levelFromXp(99), { level: 1, xpIntoLevel: 99, xpForNextLevel: 100 });
    // 100을 채우면 2레벨. 다음 비용은 150이다.
    assert.deepEqual(levelFromXp(100), { level: 2, xpIntoLevel: 0, xpForNextLevel: 150 });
    assert.deepEqual(levelFromXp(250), { level: 3, xpIntoLevel: 0, xpForNextLevel: 200 });
});

test('쓰레기 XP 값은 1레벨로 떨어진다', () => {
    // `users.stats`는 jsonb다. 컬럼 안에 무엇이 들어 있든 화면에 NaN이 나가면 안 된다.
    for (const xp of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(levelFromXp(xp).level, 1);
    }
});
