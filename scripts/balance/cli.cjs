#!/usr/bin/env node
'use strict';
/**
 * 밸런스 도구.
 *
 *   npm run balance                       지금 값·불변식·릴리스 여부를 본다
 *   npm run balance:release -- [-m "메모"] 바뀐 값을 0.x.(y+1)로 릴리스한다
 *   npm run balance:release -- --minor    0.(x+1).0 — 체감이 큰 조정
 *   npm run balance:release -- --major    1.0.0 — 밸런스 테스트를 마친 첫 정식 규칙
 *
 * 릴리스는 server-game/src/config/rules-lock.ts, CHANGELOG.md, docs/balance.md를 함께 고친다.
 * 셋 다 커밋한다. 값을 바꿨는데 릴리스하지 않으면 server-game 테스트가 실패한다.
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { simulationHash, visibilityHash } = require('./fingerprint.cjs');

const ROOT = resolve(__dirname, '..', '..');
const LOCK_FILE = resolve(ROOT, 'server-game/src/config/rules-lock.ts');
const CHANGELOG = resolve(ROOT, 'CHANGELOG.md');
const SHEET = resolve(ROOT, 'docs/balance.md');

const SOURCES = [
    ['MOVEMENT', 'shared/src/protocol/tuning.ts', '이동'],
    ['SKILL_TUNING', 'shared/src/protocol/tuning.ts', '스킬과 효과'],
    ['SPEED_DECREASE_FLOOR', 'shared/src/protocol/tuning.ts', '감속 바닥'],
    ['TILE_PX', 'shared/src/protocol/tuning.ts', '타일 크기'],
    ['PROGRESSION', 'shared/src/protocol/progression.ts', '경험치와 레벨'],
    ['GAMEPLAY', 'server-game/src/config/gameplay.ts', '서버 전용 규칙'],
    ['SKILLS', 'server-game/src/config/gameplay.ts', '서버 전용 스킬 값(대부분 SKILL_TUNING에서 단위만 바꾼 것)'],
    ['SPEED', 'server-game/src/config/gameplay.ts', '속도 계산'],
    ['EMOJI_DISPLAY_MS', 'server-game/src/config/gameplay.ts', '이모지'],
    ['NETWORK', 'server-game/src/config/network.ts', '시뮬레이션 주기'],
];

function build() {
    const steps = existsSync(resolve(ROOT, 'shared/dist/index.js')) ? ['server-game'] : ['shared', 'server-game'];
    for (const workspace of steps) {
        const result = spawnSync(`npm run build -w ${workspace}`, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], shell: true });
        if (result.status !== 0) {
            console.error(`${workspace} 빌드 실패. 먼저 타입 오류를 고친다(npm run typecheck).`);
            process.exit(1);
        }
    }
    const load = (name) => require(resolve(ROOT, 'server-game/dist/config', name));
    return {
        rules: load('rules.js'),
        invariants: load('balance-invariants.js').balanceInvariants(),
        lock: load('rules-lock.js').RULES_LOCK,
        visibilityVersion: require(resolve(ROOT, 'shared/dist/visibility/version.js')).VISIBILITY_CORE_VERSION,
    };
}

function bump(version, kind) {
    const [major, minor, patch] = version.split('.').map(Number);
    if (kind === 'major') return `${major + 1}.0.0`;
    if (kind === 'minor') return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
}

function diff(before, after) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.filter((key) => before[key] !== after[key]).map((key) => ({ key, from: before[key], to: after[key] }));
}

const show = (value) => (value === undefined ? '(없음)' : String(value));

function renderLock(lock) {
    return `// 생성 파일. \`npm run balance:release\`가 쓴다. 손으로 고치지 않는다.
// 마지막으로 릴리스한 규칙 버전과 그때의 값. rules.ts가 지금 값과 비교해 RULES_VERSION을 정한다.
export const RULES_LOCK = ${JSON.stringify(lock, null, 4).replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, '$1:').replace(/"/g, "'")} as const;
`;
}

function renderSheet(lock, invariants) {
    const out = [
        '# 밸런스 시트',
        '',
        `<!-- npm run balance:release가 생성한다. 손으로 고치지 않는다. -->`,
        '',
        `규칙 버전 **${lock.version}** (${lock.releasedAt}). 바꾸는 법은 [CONTRIBUTING.md](../CONTRIBUTING.md#밸런스-바꾸기), 지난 변경은 [CHANGELOG.md](../CHANGELOG.md).`,
        '',
        '## 지켜야 하는 관계',
        '',
        '| 관계 | 지금 값 |',
        '| --- | --- |',
        ...invariants.map((item) => `| ${item.ok ? '✓' : '✗'} ${item.name} | ${item.detail} |`),
    ];
    for (const [prefix, file, title] of SOURCES) {
        const keys = Object.keys(lock.values).filter((key) => key === prefix || key.startsWith(`${prefix}.`));
        if (keys.length === 0) continue;
        out.push('', `## ${title}`, '', `\`${file}\`의 \`${prefix}\``, '', '| 값 | |', '| --- | --- |');
        for (const key of keys) out.push(`| \`${key.slice(prefix.length + 1) || prefix}\` | ${show(lock.values[key])} |`);
    }
    return out.join('\n') + '\n';
}

function writeChangelog(version, date, changes, notes) {
    const header = `## 규칙 ${version} — ${date}`;
    const lines = [header, ''];
    if (notes) lines.push(notes, '');
    for (const change of changes.values) lines.push(`- \`${change.key}\`: ${show(change.from)} → ${show(change.to)}`);
    if (changes.simulation) lines.push('- 시뮬레이션 코드가 바뀌었다(`server-game/src/simulation/`). 값은 같아도 움직임이 다를 수 있다.');
    if (changes.visibility) lines.push(`- 시야 판정이 바뀌었다(시야 판정 버전 ${changes.visibility}).`);
    lines.push('');
    const text = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, 'utf8') : '';
    const index = text.indexOf('\n## 규칙 ');
    const next = index === -1 ? `${text.trimEnd()}\n\n${lines.join('\n')}` : `${text.slice(0, index + 1)}${lines.join('\n')}\n${text.slice(index + 1)}`;
    writeFileSync(CHANGELOG, next.endsWith('\n') ? next : `${next}\n`);
}

function status() {
    const { rules, invariants, lock, visibilityVersion } = build();
    const values = rules.balanceValues();
    const changes = diff(lock.values, values);
    const simulationChanged = simulationHash() !== lock.simulationHash;
    const visibilityChanged = visibilityHash() !== lock.visibility.hash;

    console.log(`규칙 버전 ${rules.RULES_VERSION}`);
    console.log('\n지켜야 하는 관계');
    for (const item of invariants) console.log(`  ${item.ok ? '✓' : '✗'} ${item.name}  (${item.detail})`);
    if (changes.length === 0 && !simulationChanged && !visibilityChanged) {
        console.log('\n마지막 릴리스와 같다.');
    } else {
        console.log('\n릴리스하지 않은 변경');
        for (const change of changes) console.log(`  ${change.key}: ${show(change.from)} → ${show(change.to)}`);
        if (simulationChanged) console.log('  시뮬레이션 코드 변경');
        if (visibilityChanged) console.log(`  시야 판정 코드 변경${visibilityVersion === lock.visibility.coreVersion ? ' — VISIBILITY_CORE_VERSION을 올려야 한다' : ''}`);
        console.log('\n훈련장에서 시험해 보고 확정하면: npm run balance:release -- -m "무엇을 왜"');
    }
    if (invariants.some((item) => !item.ok)) process.exitCode = 1;
}

function release(args) {
    const kind = args.includes('--major') ? 'major' : args.includes('--minor') ? 'minor' : 'patch';
    const noteIndex = args.indexOf('-m');
    const notes = noteIndex === -1 ? '' : (args[noteIndex + 1] ?? '').trim();
    const init = args.includes('--init');
    const { rules, invariants, lock, visibilityVersion } = build();

    const broken = invariants.filter((item) => !item.ok);
    if (broken.length > 0) {
        for (const item of broken) console.error(`✗ ${item.name} (${item.detail})`);
        console.error('관계가 깨진 밸런스는 릴리스하지 않는다. 의도한 변경이면 BASE.md와 balance-invariants.ts를 먼저 고친다.');
        process.exit(1);
    }

    const values = rules.balanceValues();
    const valueChanges = diff(lock.values, values);
    const simulation = simulationHash();
    const visibility = visibilityHash();
    const visibilityChanged = visibility !== lock.visibility.hash;
    if (visibilityChanged && visibilityVersion === lock.visibility.coreVersion && !init) {
        console.error('시야 판정 코드가 바뀌었는데 VISIBILITY_CORE_VERSION(shared/src/visibility/version.ts)이 그대로다. 먼저 올린다.');
        process.exit(1);
    }
    if (!init && valueChanges.length === 0 && simulation === lock.simulationHash && !visibilityChanged) {
        console.log(`바뀐 것이 없다. 규칙 버전은 ${lock.version} 그대로다.`);
        return;
    }

    const version = init ? lock.version : bump(lock.version, kind);
    const date = new Date().toISOString().slice(0, 10);
    const next = {
        version,
        releasedAt: date,
        valuesHash: rules.balanceHash(values),
        simulationHash: simulation,
        visibility: { coreVersion: visibilityVersion, hash: visibility },
        values,
    };
    writeFileSync(LOCK_FILE, renderLock(next));
    writeFileSync(SHEET, renderSheet(next, invariants));
    if (!init) {
        writeChangelog(version, date, {
            values: valueChanges,
            simulation: simulation !== lock.simulationHash,
            visibility: visibilityChanged ? visibilityVersion : null,
        }, notes);
    }
    console.log(`규칙 ${version}${init ? ' 기준선을 기록했다' : `으로 릴리스했다 (변경 ${valueChanges.length}개)`}.`);
    console.log('rules-lock.ts, docs/balance.md' + (init ? '' : ', CHANGELOG.md') + '를 커밋한다.');
}

const [command = 'status', ...args] = process.argv.slice(2);
if (command === 'status') status();
else if (command === 'release') release(args);
else {
    console.error('사용법: node scripts/balance/cli.cjs [status|release] [--minor|--major] [-m "메모"]');
    process.exit(2);
}
