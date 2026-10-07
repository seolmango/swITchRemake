'use strict';
// Parse deployment inputs and validate reachable trust boundaries, not source snapshots.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '..', '..');
const checks = [];
function check(name, run) { run(); checks.push({ name, passed: true }); }
function read(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }
try {
    const workflow = yaml.load(read('.github/workflows/verify.yml'));
    check('untrusted-workflow-events-and-permissions', () => {
        assert.ok(workflow.on.push !== undefined || Object.hasOwn(workflow.on, 'push'));
        assert.ok(Object.hasOwn(workflow.on, 'pull_request'));
        assert.ok(Object.keys(workflow.on).every(event => ['push', 'pull_request', 'schedule', 'workflow_dispatch'].includes(event)));
        assert.deepEqual(workflow.permissions, { contents: 'read' });
        assert.equal(workflow.concurrency['cancel-in-progress'], true);
        assert.ok(!/\$\{\{[^}]*\bsecrets\./i.test(JSON.stringify(workflow)));
        for (const job of Object.values(workflow.jobs)) {
            assert.equal(job['runs-on'], 'ubuntu-24.04');
            assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 90);
            assert.ok(!job.environment);
            if (job.permissions) assert.deepEqual(job.permissions, { contents: 'read' });
            for (const step of job.steps) {
                if (step.uses) {
                    assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/);
                    assert.ok(!/^(?:azure|aws-actions|google-github-actions)\//i.test(step.uses));
                    if (step.uses.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
                    if (step.uses.startsWith('actions/upload-artifact@')) {
                        assert.equal(step.with.path, 'e2e/artifacts/audit');
                        assert.equal(step.with['include-hidden-files'], false);
                        assert.ok(step.with['retention-days'] >= 1 && step.with['retention-days'] <= 14);
                    }
                }
                if (step.run) assert.ok(!/(?:^|[\s;])(?:az|aws|gcloud)\s|https?:\/\//im.test(step.run));
            }
        }
    });
    check('ci-shards-match-local-shards', () => {
        // GitHub과 로컬이 같은 기준으로 나눠 돌아야 한다. 한쪽에만 영역이 있으면 그 영역은 검사 없이 배포된다.
        const { SHARDS } = require('./areas.cjs');
        assert.deepEqual(workflow.jobs.verify.strategy.matrix.areas, SHARDS.map(shard => shard.join(' ')));
        assert.equal(workflow.jobs.verify.strategy['fail-fast'], false);
        assert.deepEqual([].concat(workflow.jobs.passed.needs), ['verify']);
    });
    const deploy = yaml.load(read('.github/workflows/deploy.yml'));
    check('deploy-only-verified-main-commits', () => {
        // PR 코드가 배포 비밀값에 닿는 경로가 없어야 하고, Verify를 통과한 main push만 배포된다.
        assert.deepEqual(Object.keys(deploy.on).sort(), ['workflow_dispatch', 'workflow_run']);
        assert.deepEqual(deploy.on.workflow_run.workflows, ['Verify']);
        assert.deepEqual(deploy.on.workflow_run.branches, ['main']);
        assert.deepEqual(deploy.permissions, { contents: 'read', actions: 'read' });
        assert.equal(deploy.concurrency['cancel-in-progress'], false);
        const [job, ...others] = Object.values(deploy.jobs);
        assert.equal(others.length, 0);
        assert.equal(job.environment, 'production');
        assert.match(job.if, /workflow_run\.conclusion == 'success'/);
        assert.match(job.if, /workflow_run\.event == 'push'/);
        const gate = job.steps.findIndex(step => /actions\/workflows\/verify\.yml\/runs\?head_sha=\$SHA&branch=main&event=push&status=success/.test(step.run ?? ''));
        const firstSecret = job.steps.findIndex(step => /secrets\./.test(JSON.stringify(step)));
        assert.ok(gate >= 0 && gate < firstSecret, 'Verify gate must run before any secret is used');
        for (const step of job.steps) {
            if (step.uses) assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/);
            if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
        }
    });
    const compose = yaml.load(read('deploy/verify/compose.yml'));
    check('runtime-isolation-and-resource-limits', () => {
        assert.deepEqual(Object.keys(compose.networks), ['isolated']);
        assert.equal(compose.networks.isolated.internal, true);
        for (const service of Object.values(compose.services)) {
            assert.deepEqual(service.networks, ['isolated']);
            assert.ok(!service.privileged && !service.network_mode && !service.devices && !service.extra_hosts);
            assert.ok(service.cpus > 0 && service.cpus <= 2);
            assert.ok(service.mem_limit && service.pids_limit > 0 && service.pids_limit <= 512);
            if (service.env_file) assert.equal(service.env_file, '${AUDIT_ENV_FILE:?audit launcher required}');
            for (const volume of service.volumes || []) {
                assert.equal(typeof volume, 'string');
                const source = volume.split(':')[0];
                assert.ok(/^[a-z_]+$/.test(source) && Object.hasOwn(compose.volumes, source));
            }
            for (const port of service.ports || []) assert.match(port, /^127\.0\.0\.1::\d+$/);
        }
        for (const name of ['match', 'cluster', 'runner']) {
            assert.deepEqual(compose.services[name].cap_drop, ['ALL']);
            assert.deepEqual(compose.services[name].security_opt, ['no-new-privileges:true']);
        }
        for (const name of ['postgres', 'redis', 'mailpit', 'web']) {
            const image = compose.services[name].image;
            assert.ok(image.startsWith('${') || /@sha256:[a-f0-9]{64}$/.test(image));
        }
    });
    check('proxy-identity-and-nonroot-backend', () => {
        const nginx = read('deploy/nginx.conf');
        const api = nginx.match(/location\s+\/api\/\s*\{([^}]+)\}/)?.[1];
        const websocket = nginx.match(/location\s+\/game-ws\s*\{([^}]+)\}/)?.[1];
        assert.ok(api?.includes('proxy_pass http://match_backend/;'));
        assert.ok(websocket?.includes('proxy_pass http://cluster_backend;'));
        assert.ok(!/proxy_set_header\s+Origin\s/i.test(nginx));
        assert.ok(nginx.includes('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'));
        for (const file of ['Dockerfile.backend', 'deploy/verify/Dockerfile.backend']) {
            const users = [...read(file).matchAll(/^USER\s+(\S+)\s*$/gm)];
            assert.equal(users.at(-1)?.[1], 'node');
        }
        // nginx's stock root master binds port 80; app workers drop privileges.
        // This baseline makes no claim that the stock web container is rootless.
    });
    check('edge-response-security-policy', () => {
      for (const file of ['deploy/Caddyfile', 'deploy/azure/Caddyfile']) {
        const caddy = read(file);
        assert.match(caddy, /Strict-Transport-Security\s+"max-age=31536000"/);
        assert.match(caddy, /X-Content-Type-Options\s+"nosniff"/);
        assert.match(caddy, /X-Frame-Options\s+"DENY"/);
        assert.match(caddy, /Referrer-Policy\s+"strict-origin-when-cross-origin"/);
        const policy = caddy.match(/Content-Security-Policy\s+"([^"]+)"/)?.[1] || '';
        assert.ok(["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'"].every(rule => policy.includes(rule)));
      }
    });
    const result = { deploymentPolicy: 'passed', checks };
    if (process.env.AUDIT_STACK === 'true') {
        fs.mkdirSync('/app/e2e/artifacts/audit', { recursive: true });
        fs.writeFileSync('/app/e2e/artifacts/audit/deployment-policy.json', JSON.stringify(result, null, 2));
    }
    console.log(JSON.stringify(result));
} catch (error) {
    console.error(JSON.stringify({ deploymentPolicy: 'failed', completedChecks: checks.map(item => item.name), location: String(error.stack || '').split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 2) }));
    process.exitCode = 1;
}
