'use strict';
const { spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
if (process.env.AUDIT_STACK !== 'true' || process.env.APP_ENV !== 'audit'
    || process.env.E2E_BASE_URL !== 'http://web' || process.env.DB_HOST !== 'postgres'
    || process.env.REDIS_HOST !== 'redis' || process.env.SMTP_HOST !== 'mailpit'
    || process.env.REPLAY_STORE !== 'local' || process.env.SWITCH_SKIP_ENV_FILE !== 'true') {
    throw new Error('Audit runner refuses a non-isolated configuration');
}
const run = (args, unit = false) => {
    const unitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        /^(PATH|HOME|TMP|TEMP|CI|NODE_OPTIONS|SWITCH_SKIP_ENV_FILE|AUDIT_STACK|DB_.*|REDIS_.*)$/.test(name)));
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: unit ? { ...unitEnvironment, AUDIT_UNIT: 'true', APP_ENV: 'dev' } : process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status || 1;
    return result.status === 0;
};
mkdirSync('/app/e2e/artifacts/audit', { recursive: true });
const checks = [];
let failed = false;
/*
 * 표준의 단계. 각 단계는 영역(area)에 속하고, `npm run verify -- <영역...>`이면 그 영역만 돈다.
 * 영역 이름과 설명은 scripts/verify/areas.cjs가 원본이다.
 */
const { selectedAreas, BROWSER_AREAS } = require('./areas.cjs');
const areas = selectedAreas(process.env.AUDIT_AREAS);
const browserFolders = BROWSER_AREAS.filter((area) => areas.has(area)).map((area) => `specs/${area}`);
const STAGES = [
    ['static', 'deployment-policy', ['scripts/verify/deployment-policy.cjs']],
    ['static', 'typecheck', ['scripts/run-workspaces.cjs', 'typecheck', 'shared', 'server-match', 'server-game', 'server-gateway', 'server-supervisor', 'client']],
    ['static', 'e2e-typecheck', ['node_modules/typescript/bin/tsc', '--project', 'e2e/tsconfig.json']],
    ['static', 'lint', ['scripts/run-workspaces.cjs', 'lint', 'client']],
    ['unit', 'unit', ['scripts/run-workspaces.cjs', 'test', 'shared', 'server-match', 'server-game', 'server-gateway', 'server-supervisor', 'client']],
    ['unit', 'tool-unit', ['--test', 'scripts/env/env.test.cjs', 'scripts/verify/environment.test.cjs', 'scripts/verify/replay-keys.test.cjs', 'scripts/verify/bots.test.cjs']],
    ['security', 'egress', ['scripts/verify/fault-probe.cjs', 'egress']],
    ['security', 'result-durability', ['scripts/verify/result-durability.cjs']],
    ['security', 'atomic-handoff', ['scripts/verify/atomic-handoff.cjs']],
    ['browser', 'browser', ['node_modules/@playwright/test/cli.js', 'test', '--config', 'e2e/playwright.config.ts', ...browserFolders]],
];
for (const [area, name, args] of STAGES) {
    if (area === 'browser' ? browserFolders.length === 0 : !areas.has(area)) { checks.push({ name, status: 'skipped', reason: 'area-not-selected' }); continue; }
    if (failed) { checks.push({ name, status: 'not-run', reason: 'prior-stage-failed' }); continue; }
    const passed = run(args, area === 'unit');
    checks.push({ name, status: passed ? 'passed' : 'failed', passed });
    if (!passed) failed = true;
}
writeFileSync('/app/e2e/artifacts/audit/checks.json', JSON.stringify({ run: process.env.AUDIT_RUN_ID, mode: process.env.AUDIT_MODE, checks }, null, 2));
