'use strict';
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync, readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { assertNoInheritedDeploymentSettings } = require('./audit-environment.cjs');
const { createReplaySigningSettings, validateReplaySigningSettings, normalizeLegacyPublicSetting } = require('./audit-replay-keys.cjs');

const root = resolve(__dirname, '..');
const action = process.argv[2] || 'run';
const mode = process.argv[3] || 'core';
if (!['run', 'up', 'start', 'normalize-keys', 'refresh', 'refresh-web', 'refresh-backend', 'rebuild', 'test', 'browser', 'browser-probe', 'bots', 'scaling', 'stalled-worker', 'faults', 'down', 'status', 'progress'].includes(action) || !['core', 'extended'].includes(mode)) throw new Error('Usage: audit-stack.cjs run|up|start|normalize-keys|refresh|refresh-web|refresh-backend|rebuild|test|browser|browser-probe|bots|scaling|stalled-worker|faults|down|status|progress core|extended');
const runId = process.env.AUDIT_RUN_ID || `local-${Date.now().toString(36)}`;
if (!/^[a-z0-9][a-z0-9-]{1,55}$/.test(runId)) throw new Error('AUDIT_RUN_ID must be a short lowercase disposable run identifier');
const project = `switch-audit-${runId}`;
const directory = resolve(root, '.audit', runId);
const envPath = resolve(directory, 'runtime.env');
const evidence = resolve(root, 'e2e', 'artifacts', 'audit', runId);
// No repository .env is parsed, and no credentials/destinations are inherited by containers.
assertNoInheritedDeploymentSettings(process.env);
const observations = { inheritedDeploymentSettings: 'passed', localDockerContext: 'not-run', runtimeEnvironment: 'not-run', startup: 'not-run' };
let ownsCreatedRun = false;
let sensitive = [];
const sanitize = (input) => {
    let text = String(input || '');
    for (const value of sensitive) if (value.length >= 6) text = text.split(value).join('[REDACTED]');
    return text.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
        .replace(/("(?:password|accessToken|refreshToken|humanProof|challengeToken|code)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
        .replace(/fill\([^\r\n)]*\)/gi, 'fill([REDACTED])')
        .replace(/filling\s+[^\r\n]*/gi, 'filling [REDACTED]')
        .replace(/ticket=[A-Za-z0-9_-]+/g, 'ticket=[REDACTED]');
};
const dockerEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|ProgramFiles(?:\(x86\))?|DOCKER_CONFIG|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|BUILDKIT_PROGRESS)$/i.test(key)));
if (dockerEnv.DOCKER_HOST && !/^(npipe:|unix:)/.test(dockerEnv.DOCKER_HOST)) throw new Error('Audit refuses remote Docker engines');
dockerEnv.DOCKER_BUILDKIT = '1';
function docker(args, { allowFailure = false, quiet = false, timeoutMs = 1_200_000 } = {}) {
    const result = spawnSync('docker', args, { cwd: root, env: dockerEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
    if (!quiet) process.stdout.write(sanitize(result.stdout) + sanitize(result.stderr));
    const operation = args[0] === 'compose'
        ? `compose ${args.find(value => ['up', 'run', 'exec', 'build', 'port', 'version', 'logs', 'ps', 'cp', 'start', 'stop', 'restart', 'down'].includes(value)) || 'command'}`
        : args[0];
    // Quiet successes avoid noisy/raw metadata; failures must remain diagnosable.
    // Never echo argv: it may contain synthetic credential values.
    if (quiet && (result.status || result.error)) {
        process.stderr.write(sanitize(`Docker ${operation} failed (${result.status ?? 'spawn'}).\n${result.stderr || ''}`));
    }
    if (result.error) throw result.error;
    if (result.status && !allowFailure) throw new Error(`Docker operation failed (${result.status}): ${operation}`);
    return result;
}
const composeArgs = ['compose', '--project-name', project, '--env-file', envPath, '-f', 'deploy/audit/compose.yml'];
const compose = (args, options) => docker([...composeArgs, ...args], options);
function load({ normalizeLegacyKey = false } = {}) {
    if (!existsSync(envPath)) throw new Error('Run-scoped environment missing; use up/run with the same AUDIT_RUN_ID first');
    const lines = readFileSync(envPath, 'utf8').trim().split('\n');
    if (lines.some(line => !/^[A-Z][A-Z0-9_]*=[^\r\n]*$/.test(line))) throw new Error('Malformed audit environment; values must fit on one line');
    const entries = Object.fromEntries(lines.map(line => {
        const separator = line.indexOf('='); return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    if (entries.AUDIT_PROJECT !== project || entries.DB_HOST !== 'postgres' || entries.APP_ENV !== 'audit'
        || entries.REDIS_HOST !== 'redis' || entries.SMTP_HOST !== 'mailpit'
        || entries.DB_USER !== 'audit' || entries.DB_NAME !== `audit_${runId.replaceAll('-', '_')}` || entries.DB_SSL !== 'false'
        || entries.REPLAY_STORE !== 'local' || entries.EMAIL_TRANSPORT !== 'smtp' || entries.E2E_BASE_URL !== 'http://web'
        || entries.AUDIT_BACKEND_IMAGE !== `${project}-backend:local` || entries.AUDIT_WEB_IMAGE !== `${project}-web:local` || entries.AUDIT_RUNNER_IMAGE !== `${project}-runner:local`
        || entries.AUDIT_ENV_FILE !== envPath.replaceAll('\\', '/')) throw new Error('Refusing altered audit environment');
    if (Object.keys(entries).some(name => /^(AZURE_|AWS_|GOOGLE_APPLICATION_CREDENTIALS$|DATABASE_URL$)/i.test(name))) throw new Error('Audit refused cloud settings in runtime file');
    if (normalizeLegacyKey) {
        const normalized = normalizeLegacyPublicSetting(entries.REPLAY_SIGNING_KEY, entries.REPLAY_SIGNING_PUBLIC_KEYS);
        if (normalized !== entries.REPLAY_SIGNING_PUBLIC_KEYS) {
            entries.REPLAY_SIGNING_PUBLIC_KEYS = normalized;
            writeFileSync(envPath, Object.entries(entries).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
        }
    }
    validateReplaySigningSettings(entries.REPLAY_SIGNING_KEY, entries.REPLAY_SIGNING_PUBLIC_KEYS);
    sensitive = Object.entries(entries).filter(([name]) => /SECRET|PASSWORD|KEY/.test(name)).map(([, value]) => value);
    observations.runtimeEnvironment = 'validated';
    return entries;
}
function prepare() {
    if (existsSync(envPath)) throw new Error('Run identifier already exists; choose another AUDIT_RUN_ID');
    const existing = docker(['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${project}`], { quiet: true });
    if (existing.stdout.trim()) throw new Error('Audit project identifier already has containers; choose another run identifier');
    for (const resource of ['volume', 'network']) {
        const found = docker([resource, 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`], { quiet: true });
        if (found.stdout.trim()) throw new Error(`Audit identifier already owns ${resource} resources; choose another run identifier`);
    }
    mkdirSync(directory, { recursive: true });
    mkdirSync(evidence, { recursive: true });
    const secret = () => randomBytes(36).toString('base64url');
    const replayKeys = createReplaySigningSettings();
    const values = {
        AUDIT_PROJECT: project, AUDIT_RUN_ID: runId, AUDIT_MODE: mode, AUDIT_STACK: 'true', APP_ENV: 'audit',
        AUDIT_ENV_FILE: envPath.replaceAll('\\', '/'), AUDIT_BACKEND_IMAGE: `${project}-backend:local`,
        AUDIT_WEB_IMAGE: `${project}-web:local`, AUDIT_RUNNER_IMAGE: `${project}-runner:local`,
        SWITCH_SKIP_ENV_FILE: 'true', NODE_OPTIONS: '--require=/app/scripts/audit-egress.cjs',
        DB_HOST: 'postgres', DB_PORT: '5432', DB_USER: 'audit', DB_NAME: `audit_${runId.replaceAll('-', '_')}`, DB_PASSWORD: secret(), DB_SSL: 'false',
        REDIS_HOST: 'redis', REDIS_PORT: '6379', REDIS_PASSWORD: secret(),
        JWT_ACCESS_SECRET: secret(), JWT_REFRESH_SECRET: secret(), JWT_GUEST_REFRESH_SECRET: secret(),
        JWT_ACCESS_EXPIRATION: '900', JWT_REFRESH_EXPIRATION: '86400', JWT_GUEST_EXPIRATION: '900', JWT_GUEST_REFRESH_EXPIRATION: '3600',
        SESSION_IP_HMAC_SECRET: secret(), SESSION_IP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MFA_TOTP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'mailpit', SMTP_PORT: '1025', SMTP_SECURE: 'false', SMTP_FROM: 'audit@switch.test',
        AUDIT_MAIL_URL: 'http://mailpit:8025', E2E_BASE_URL: 'http://web',
        PORT: '3000', GAME_HOST: '0.0.0.0', GAME_INTERNAL_HOST: '127.0.0.1', GAME_PORT: '4000',
        GAME_MAP_BUNDLE: '/app/server-game/maps/server_maps.json', GAME_ALLOWED_ORIGINS: 'http://web', GAME_TRUSTED_PROXIES: 'loopback,uniquelocal',
        MATCH_TRUSTED_PROXIES: 'uniquelocal', GATEWAY_HOST: '0.0.0.0', GATEWAY_PORT: '4100', GATEWAY_ALLOWED_GAME_HOSTS: '127.0.0.1,localhost,::1',
        SUPERVISOR_MIN_SERVERS: '1', SUPERVISOR_MAX_SERVERS: '2',
        SUPERVISOR_SCALE_UP_LOAD: '3', SUPERVISOR_SCALE_DOWN_LOAD: '1.3', SUPERVISOR_COOLDOWN_MS: '5000',
        REPLAY_ENABLED: 'true', REPLAY_STORE: 'local', REPLAY_LOCAL_DIR: '/app/replays', REPLAY_SIGNING_KEY_ID: 'audit',
        REPLAY_SIGNING_KEY: replayKeys.privateEncoded,
        REPLAY_SIGNING_PUBLIC_KEYS: replayKeys.publicSetting, BUILD_ID: project,
    };
    if (Object.values(values).some(value => /[\r\n]/.test(value))) throw new Error('Audit setting cannot contain a newline');
    // Exclusive creation prevents another launch from winning the identifier race.
    writeFileSync(envPath, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    ownsCreatedRun = true;
    return load();
}
function build(values) {
    docker(['build', '-f', 'deploy/audit/Dockerfile.backend', '-t', values.AUDIT_BACKEND_IMAGE, '.']);
    // Advisory fetch is a build-phase query: no app env, mounts or credentials.
    const audit = docker(['run', '--rm', '--network', 'bridge', '--entrypoint', 'node', values.AUDIT_BACKEND_IMAGE, 'scripts/audit-dependencies.cjs'], { allowFailure: true, quiet: true, timeoutMs: 120_000 });
    mkdirSync(evidence, { recursive: true });
    writeFileSync(resolve(evidence, 'dependencies.json'), sanitize(audit.stdout));
    if (audit.status !== 0) { process.stdout.write(sanitize(audit.stdout)); throw new Error('Production dependency audit rejected this build or advisory query failed'); }
    docker(['build', '-f', 'deploy/audit/Dockerfile.web', '--build-arg', `AUDIT_BACKEND_IMAGE=${values.AUDIT_BACKEND_IMAGE}`, '-t', values.AUDIT_WEB_IMAGE, '.']);
    docker(['build', '-f', 'deploy/audit/Dockerfile.runner', '--build-arg', `AUDIT_BACKEND_IMAGE=${values.AUDIT_BACKEND_IMAGE}`, '-t', values.AUDIT_RUNNER_IMAGE, '.']);
}
function collect() {
    mkdirSync(evidence, { recursive: true });
    const id = compose(['ps', '-a', '-q', 'runner'], { quiet: true }).stdout.trim();
    if (id) docker(['cp', `${id}:/app/e2e/artifacts/.`, evidence], { allowFailure: true, quiet: true });
    const cluster = compose(['ps', '-q', 'cluster'], { quiet: true, allowFailure: true }).stdout.trim();
    if (cluster) {
        const available = compose(['exec', '-T', 'cluster', 'node', '-e', "const fs=require('node:fs');console.log(JSON.stringify(['audit-scaling-processes.json','audit-stalled-worker.json'].filter(name=>fs.existsSync('/tmp/'+name))))"], { quiet: true, allowFailure: true, timeoutMs: 10_000 });
        if (available.status === 0) for (const report of JSON.parse(available.stdout)) {
            if (!['audit-scaling-processes.json', 'audit-stalled-worker.json'].includes(report)) throw new Error('Unexpected audit report path');
            docker(['cp', `${cluster}:/tmp/${report}`, resolve(evidence, report.replace(/^audit-/, ''))], { allowFailure: true, quiet: true });
        }
    }
    const scrub = (folder) => {
        for (const item of readdirSync(folder, { withFileTypes: true })) {
            const target = resolve(folder, item.name);
            if (item.isSymbolicLink()) { unlinkSync(target); continue; }
            if (item.isDirectory()) scrub(target);
            else if (item.name === 'error-context.md') unlinkSync(target);
            else if (/\.(json|txt|md|log|html|xml)$/i.test(item.name)) writeFileSync(target, sanitize(readFileSync(target, 'utf8')));
            else if (!/\.png$/i.test(item.name)) unlinkSync(target);
        }
    };
    scrub(evidence);
    const summary = compose(['ps', '-a', '--format', 'json'], { allowFailure: true, quiet: true });
    writeFileSync(resolve(evidence, 'stack-status.json'), sanitize(summary.stdout));
    // Logs are synthetic but can contain codes or cookies; keep only safe operation metadata.
    const network = docker(['network', 'inspect', `${project}_isolated`, '--format', '{{.Internal}}'], { quiet: true, allowFailure: true, timeoutMs: 15_000 });
    const observedInternal = network.status === 0 && /^(true|false)$/.test(network.stdout.trim()) ? network.stdout.trim() === 'true' : null;
    writeFileSync(resolve(evidence, 'isolation.json'), JSON.stringify({
        project,
        declaredDesign: { internalNetwork: true, syntheticDatabase: true, localSmtp: true, localReplayStorage: true,
            externalRoutes: 'disabled', credentialInheritance: 'refused' },
        observed: { internalNetwork: observedInternal, networkProbeStatus: observedInternal === null ? 'unknown' : 'observed' },
        preflight: observations,
    }, null, 2));
}
function cleanup() {
    load();
    // Explicit project+file+generated env. Never prune or touch other projects.
    compose(['down', '--volumes', '--remove-orphans', '--timeout', '20']);
    unlinkSync(envPath);
    writeFileSync(resolve(directory, 'cleaned.json'), JSON.stringify({ project, cleanedAt: new Date().toISOString() }));
}
function faults() {
    const checks = [];
    const processCount = () => {
        const code = "const fs=require('node:fs');const pids=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).filter(p=>{try{return(fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0')[1]||'').endsWith('/server-game/dist/main.js')}catch{return false}});console.log(JSON.stringify({gameChildren:pids.length,pids:pids.map(Number).sort((a,b)=>a-b)}))";
        const result = compose(['exec', '-T', 'cluster', 'node', '-e', code], { quiet: true, timeoutMs: 10_000 });
        return JSON.parse(result.stdout);
    };
    const probe = (name) => {
        const passed = compose(['run', '--rm', '--no-deps', 'runner', 'node', 'scripts/audit-fault-probe.cjs', name], { allowFailure: true, timeoutMs: 60_000 }).status === 0;
        checks.push({ name, passed });
        if (!passed) throw new Error(`Audit fault probe failed: ${name}`);
    };
    try {
        probe('seed');
        try { compose(['stop', '--timeout', '5', 'postgres'], { timeoutMs: 60_000 }); probe('health-down'); }
        finally { compose(['start', 'postgres'], { timeoutMs: 60_000 }); }
        probe('health-up'); probe('session');
        const before = processCount();
        try {
            compose(['stop', '--timeout', '5', 'redis'], { timeoutMs: 60_000 }); probe('health-down');
            spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},6000)'], { timeout: 8_000 });
            const during = processCount();
            const passed = before.gameChildren === during.gameChildren && JSON.stringify(before.pids) === JSON.stringify(during.pids);
            checks.push({ name: 'redis-outage-no-runaway-process-spawn', before, during, passed });
            if (!passed) throw new Error('Game child processes changed during bounded Redis outage');
        }
        finally { compose(['start', 'redis'], { timeoutMs: 60_000 }); }
        probe('health-up');
        compose(['restart', '--timeout', '5', 'match'], { timeoutMs: 60_000 });
        probe('health-up');
        probe('session');
        try {
            compose(['exec', '-T', 'cluster', 'chmod', '555', '/app/replays'], { timeoutMs: 60_000 });
            const passed = compose(['exec', '-T', 'cluster', 'node', 'scripts/audit-fault-probe.cjs', 'replay-denied'], { allowFailure: true, timeoutMs: 60_000 }).status === 0;
            checks.push({ name: 'replay-write-denied', passed });
            if (!passed) throw new Error('Expected actual replay volume write denial');
        } finally { compose(['exec', '-T', 'cluster', 'chmod', '755', '/app/replays'], { timeoutMs: 60_000 }); }
        const restored = compose(['exec', '-T', 'cluster', 'node', 'scripts/audit-fault-probe.cjs', 'replay-restored'], { allowFailure: true, timeoutMs: 60_000 }).status === 0;
        checks.push({ name: 'replay-write-restored', passed: restored });
        if (!restored) throw new Error('Replay volume recovery failed');
    } finally {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(resolve(evidence, 'faults.json'), JSON.stringify({ project, checks }, null, 2));
    }
}
function observeScaling() {
    compose(['exec', '-d', 'cluster', 'node', 'scripts/audit-observe-scaling.cjs']);
}
function verifyScaling() {
    const result = compose(['exec', '-T', 'cluster', 'node', '-e', "const fs=require('node:fs');(async()=>{const phases=['initial-one','scaled-two','drained-one','complete'];const deadline=Date.now()+5000;while(Date.now()<deadline){try{const e=JSON.parse(fs.readFileSync('/tmp/audit-scaling-processes.json'));if(!e.timeout&&!e.failed&&phases.every(phase=>e.evidence.some(x=>x.phase===phase&&x.passed))){console.log('Actual Linux game worker processes verified: 1 -> 2 -> 1');return}}catch{}await new Promise(r=>setTimeout(r,250))}process.exitCode=1})()"], { allowFailure: true, timeoutMs: 15_000 });
    collect();
    if (result.status !== 0) throw new Error('Scaling failed actual OS worker process gate');
}
function stalledWorker() {
    // The probe independently validates idle audit-only PID identities and has a detached resume watchdog.
    compose(['cp', 'scripts/audit-stalled-worker.cjs', 'cluster:/app/scripts/audit-stalled-worker.cjs'], { timeoutMs: 15_000 });
    const result = compose(['exec', '-T', 'cluster', 'node', 'scripts/audit-stalled-worker.cjs'], { allowFailure: true, timeoutMs: 65_000 });
    collect();
    if (result.status !== 0) throw new Error('Audit stalled worker process-cap probe failed');
}
function startStack() {
    // A successful one-shot migration is Exited(0), not a long-running healthy service.
    // Waiting on a dependency graph containing it differs between Compose versions.
    // Enforce each boundary explicitly and never suppress the migration exit status.
    observations.startup = 'running';
    try {
        compose(['up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'redis', 'mailpit'], { timeoutMs: 240_000 });
        compose(['run', '--rm', '--no-deps', 'migrate'], { timeoutMs: 180_000 });
        compose(['up', '-d', '--wait', '--wait-timeout', '180', '--no-deps', 'match', 'cluster'], { timeoutMs: 240_000 });
        compose(['up', '-d', '--wait', '--wait-timeout', '180', '--no-deps', 'web'], { timeoutMs: 240_000 });
        observations.startup = 'passed';
    } finally { if (observations.startup === 'running') observations.startup = 'failed'; }
}
function versions() {
    const engine = docker(['version', '--format', '{{json .}}'], { quiet: true, timeoutMs: 15_000 });
    const composeVersion = docker(['compose', 'version', '--short'], { quiet: true, timeoutMs: 15_000 });
    const parsed = JSON.parse(engine.stdout);
    mkdirSync(evidence, { recursive: true });
    writeFileSync(resolve(evidence, 'runtime-versions.json'), JSON.stringify({
        dockerClient: parsed.Client.Version, dockerServer: parsed.Server.Version,
        compose: composeVersion.stdout.trim(), nodeLauncher: process.version,
    }, null, 2));
}
let shouldCleanup = action === 'run';
let mayAccessLocalDocker = false;
try {
    const context = docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { quiet: true });
    if (context.status !== 0 || !/^(npipe:|unix:)/.test(context.stdout.trim())) {
        observations.localDockerContext = 'failed';
        throw new Error('Audit refuses non-local Docker contexts');
    }
    observations.localDockerContext = 'passed';
    mayAccessLocalDocker = true;
    if (action === 'run' || action === 'up' || action === 'rebuild' || action === 'start') {
        const values = action === 'rebuild' || action === 'start' ? load() : prepare();
        versions();
        if (action !== 'start') build(values);
        startStack();
        const network = docker(['network', 'inspect', `${project}_isolated`, '--format', '{{.Internal}}'], { quiet: true });
        if (network.stdout.trim() !== 'true') throw new Error('Audit refuses a network with external routing');
        // Optional display metadata: internal-only Docker networks may have no host binding.
        // Service readiness and network isolation above are mandatory regardless of this lookup.
        const port = compose(['port', 'web', '80'], { quiet: true, allowFailure: true, timeoutMs: 15_000 }).stdout.trim();
        console.log(`Audit stack ${project} ready at internal http://web${port.startsWith('127.0.0.1:') ? ` (host http://${port})` : ''}. Runtime env path: .audit/${runId}/runtime.env (do not print contents).`);
        if (action === 'up' || action === 'rebuild') shouldCleanup = false;
    } else load({ normalizeLegacyKey: action === 'normalize-keys' });
    if (action === 'normalize-keys') {
        compose(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'match'], { timeoutMs: 240_000 });
        console.log('Audit replay public key validated as matching Ed25519 raw32; matching service ready. Key values omitted.');
    }
    if (action === 'refresh') {
        const values = load();
        docker(['build', '-f', 'deploy/audit/Dockerfile.refresh', '--build-arg', `AUDIT_RUNNER_IMAGE=${values.AUDIT_RUNNER_IMAGE}`, '-t', values.AUDIT_RUNNER_IMAGE, '.']);
    }
    if (action === 'refresh-web') {
        const values = load();
        docker(['build', '-f', 'deploy/audit/Dockerfile.web', '--build-arg', `AUDIT_BACKEND_IMAGE=${values.AUDIT_BACKEND_IMAGE}`, '-t', values.AUDIT_WEB_IMAGE, '.']);
        compose(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'web'], { timeoutMs: 240_000 });
    }
    if (action === 'refresh-backend') {
        const values = load();
        docker(['build', '-f', 'deploy/audit/Dockerfile.backend-refresh', '--build-arg', `AUDIT_BACKEND_IMAGE=${values.AUDIT_BACKEND_IMAGE}`, '-t', values.AUDIT_BACKEND_IMAGE, '.']);
        versions();
        startStack();
    }
    if (action === 'run' || action === 'test') {
        const current = readFileSync(envPath, 'utf8');
        writeFileSync(envPath, current.replace(/^AUDIT_MODE=.*$/m, `AUDIT_MODE=${mode}`), { mode: 0o600 });
        if (mode === 'extended') observeScaling();
        const result = compose(['up', '--no-deps', '--abort-on-container-exit', '--exit-code-from', 'runner', 'runner'], { allowFailure: true });
        collect();
        if (result.status) process.exitCode = result.status;
        else if (mode === 'extended') { verifyScaling(); faults(); stalledWorker(); }
    }
    if (action === 'faults') faults();
    if (action === 'stalled-worker') stalledWorker();
    if (action === 'browser-probe') { compose(['run', '--rm', '--no-deps', 'runner', 'node', 'scripts/audit-browser-probe.cjs'], { timeoutMs: 60_000 }); collect(); }
    if (action === 'browser') {
        const browserArgs = process.argv.slice(4);
        const grepIndex = browserArgs.indexOf('--grep');
        const specs = grepIndex < 0 ? browserArgs : browserArgs.slice(0, grepIndex);
        if (!specs.length || specs.some(spec => !/^[a-z]+\.spec\.ts$/.test(spec))) throw new Error('Browser action requires audit spec basenames');
        if (grepIndex >= 0 && (browserArgs.length !== grepIndex + 2 || !browserArgs[grepIndex + 1] || browserArgs[grepIndex + 1].length > 100)) throw new Error('Browser grep must be a single bounded pattern');
        const result = compose(['run', '--rm', '--no-deps', 'runner', 'node', 'node_modules/@playwright/test/cli.js', 'test', '--config', 'e2e/audit.config.ts', ...browserArgs], { allowFailure: true, timeoutMs: 600_000 });
        collect();
        const summary = resolve(evidence, 'audit', 'summary.json');
        if (existsSync(summary)) writeFileSync(resolve(evidence, `browser-${specs.join('-').replaceAll('.spec.ts', '')}-${Date.now()}.json`), readFileSync(summary));
        if (result.status) process.exitCode = result.status;
    }
    if (action === 'bots') {
        const result = compose(['run', '--rm', '--no-deps', 'runner', 'node', 'scripts/audit-bots.cjs', ...process.argv.slice(4)], { allowFailure: true, timeoutMs: 330_000 });
        if (result.status) process.exitCode = result.status;
    }
    if (action === 'scaling') {
        observeScaling();
        const result = compose(['run', '--rm', '--no-deps', 'runner', 'node', 'node_modules/@playwright/test/cli.js', 'test', '--config', 'e2e/audit.config.ts', 'scaling.spec.ts'], { allowFailure: true, timeoutMs: 330_000 });
        collect();
        if (result.status) process.exitCode = result.status;
        else verifyScaling();
    }
    if (action === 'status') compose(['ps']);
    if (action === 'progress') {
        const tail = Number(process.argv[4] ?? 12);
        if (!Number.isInteger(tail) || tail < 1 || tail > 200) throw new Error('Progress tail must be between 1 and 200');
        const ids = docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=runner'], { quiet: true }).stdout.trim().split('\n').filter(Boolean);
        if (ids.length) for (const id of ids) docker(['logs', '--tail', String(tail), id]);
        else compose(['logs', '--no-log-prefix', '--tail', String(tail), 'runner']);
    }
    if (action === 'down') cleanup();
} catch (error) {
    console.error(sanitize(error.message));
    process.exitCode = 1;
} finally {
    if (shouldCleanup && ownsCreatedRun && mayAccessLocalDocker && existsSync(envPath)) {
        try { collect(); } catch (error) { console.error(sanitize(`Audit evidence collection failed: ${error.message}`)); process.exitCode = 1; }
        // Evidence failure must never prevent cleanup of this launch's own resources.
        try { cleanup(); } catch (error) { console.error(sanitize(`Audit cleanup failed: ${error.message}`)); process.exitCode = 1; }
    }
}
