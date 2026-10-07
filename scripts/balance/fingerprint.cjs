'use strict';
/**
 * 규칙 코드의 지문. 주석·공백만 고친 것은 같은 지문이 되고, 실행되는 코드가 바뀌면 달라진다.
 *
 * `server-game/src/config/rules.test.ts`와 `npm run balance:release`가 함께 쓴다.
 */
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..', '..');

/** 경기 결과를 정하는 시뮬레이션 파일. 테스트 도우미와 틱 페이싱(scheduler)은 결과를 바꾸지 않아 뺀다. */
const SIMULATION_DIR = 'server-game/src/simulation';
const SIMULATION_EXCLUDE = new Set(['testing.ts', 'scheduler.ts']);
const VISIBILITY_FILES = ['shared/src/visibility/core.ts'];

function simulationFiles() {
    return readdirSync(join(ROOT, SIMULATION_DIR))
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !SIMULATION_EXCLUDE.has(name))
        .sort()
        .map((name) => `${SIMULATION_DIR}/${name}`);
}

function normalized(file) {
    const ts = require(require.resolve('typescript', { paths: [ROOT] }));
    const source = readFileSync(join(ROOT, file), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022 } }).outputText;
    return output.replace(/\s+/g, '');
}

function hashFiles(files) {
    const hash = createHash('sha256');
    for (const file of files) hash.update(`${file}\0${normalized(file)}\0`);
    return hash.digest('hex');
}

module.exports = {
    simulationFiles,
    simulationHash: () => hashFiles(simulationFiles()),
    visibilityHash: () => hashFiles(VISIBILITY_FILES),
};
