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
for (const [name, args] of [
    ['deployment-policy', ['scripts/audit-deployment-policy.cjs']],
    ['egress', ['scripts/audit-fault-probe.cjs', 'egress']],
    ['typecheck', ['scripts/run-workspaces.cjs', 'typecheck', 'shared', 'server-match', 'server-game', 'server-gateway', 'server-supervisor', 'client']],
    ['audit-typecheck', ['node_modules/typescript/bin/tsc', '--project', 'e2e/audit.tsconfig.json']],
    ['lint', ['scripts/run-workspaces.cjs', 'lint', 'client']],
    ['unit', ['scripts/run-workspaces.cjs', 'test', 'shared', 'server-match', 'server-game', 'server-gateway', 'server-supervisor', 'client']],
    ['bots-unit', ['--test', 'scripts/audit-bots.test.cjs']],
    ['browser', ['node_modules/@playwright/test/cli.js', 'test', '--config', 'e2e/audit.config.ts', ...(process.env.AUDIT_MODE === 'core' ? ['multiplayer.spec.ts', 'security.spec.ts', 'ui.spec.ts', 'multitab.spec.ts'] : [])]],
]) {
    if (failed) { checks.push({ name, status: 'not-run', reason: 'prior-stage-failed' }); continue; }
    const passed = run(args, name === 'unit');
    checks.push({ name, status: passed ? 'passed' : 'failed', passed });
    if (!passed) failed = true;
}
writeFileSync('/app/e2e/artifacts/audit/checks.json', JSON.stringify({ run: process.env.AUDIT_RUN_ID, mode: process.env.AUDIT_MODE, checks }, null, 2));
