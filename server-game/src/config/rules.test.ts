import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { VISIBILITY_CORE_VERSION } from 'shared';
import { balanceInvariants } from './balance-invariants';
import { balanceHash, balanceValues, rulesVersion, RULES_VERSION } from './rules';
import { RULES_LOCK } from './rules-lock';

// 테스트는 dist-test/config에서 돈다. 저장소 루트의 지문 도구를 그대로 쓴다.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fingerprint = require(resolve(__dirname, '../../../scripts/balance/fingerprint.cjs')) as {
    simulationHash(): string;
    visibilityHash(): string;
};

const RELEASE = '훈련장에서 확인했으면 `npm run balance:release -- -m "무엇을 왜"`로 버전을 올리고 rules-lock.ts·CHANGELOG.md·docs/balance.md를 함께 커밋한다';

test('밸런스 값이 마지막 릴리스와 같다', () => {
    const now = balanceValues();
    const changed = Object.keys({ ...now, ...RULES_LOCK.values })
        .filter((key) => now[key] !== (RULES_LOCK.values as Record<string, unknown>)[key]);
    assert.deepEqual(changed, [], `릴리스하지 않은 밸런스 변경: ${changed.join(', ')}. ${RELEASE}`);
    assert.equal(RULES_VERSION, RULES_LOCK.version);
});

test('시뮬레이션 코드가 마지막 릴리스와 같다', () => {
    assert.equal(fingerprint.simulationHash(), RULES_LOCK.simulationHash,
        `server-game/src/simulation/의 실행 코드가 바뀌었다. 움직임이 달라질 수 있으니 규칙 버전도 바뀌어야 한다. ${RELEASE}`);
});

test('시야 판정이 바뀌면 시야 판정 버전도 바뀐다', () => {
    if (fingerprint.visibilityHash() === RULES_LOCK.visibility.hash) return;
    assert.notEqual(VISIBILITY_CORE_VERSION, RULES_LOCK.visibility.coreVersion,
        'shared/src/visibility/core.ts가 바뀌었다. 과거 리플레이의 개인 시점이 달라지므로 VISIBILITY_CORE_VERSION을 올린다(BASE.md §2.8)');
    assert.fail(`시야 판정 버전을 올렸으면 ${RELEASE}`);
});

test('릴리스하지 않은 값으로 돈 경기는 dev 표시가 붙은 버전을 남긴다', () => {
    assert.equal(rulesVersion(RULES_LOCK.valuesHash), RULES_LOCK.version);
    assert.match(rulesVersion('0123456789abcdef'), new RegExp(`^${RULES_LOCK.version.replace(/\./g, '\.')}-dev\.01234567$`));
    assert.equal(balanceHash(), RULES_LOCK.valuesHash);
});

for (const item of balanceInvariants()) {
    test(`밸런스 관계: ${item.name}`, () => assert.ok(item.ok, item.detail));
}
