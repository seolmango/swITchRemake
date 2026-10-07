#!/usr/bin/env node
'use strict';
/**
 * `npm run verify`의 입구. swITch 표준을 일회용 격리 스택에서 돌린다(CONTRIBUTING.md).
 *
 *   npm run verify                         전부, 스택 하나
 *   npm run verify -- account rooms        일부 영역만
 *   npm run verify -- --parallel 2         묶음(areas.cjs의 SHARDS)을 스택 2개에 나눠 동시에
 *   npm run verify -- --extended           + 인게임 서버 증감·장애 주입(스택 하나)
 *
 * 스택 하나는 메모리를 최대 약 6GB 쓴다. --parallel은 그만큼 곱해진다.
 * GitHub의 Verify는 묶음마다 워커를 따로 받아 `npm run verify -- <묶음의 영역>`을 부른다 — 같은 명령이다.
 */
const { spawn, spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { SHARDS, selectedAreas } = require('./areas.cjs');

const ROOT = resolve(__dirname, '..', '..');
const STACK = resolve(__dirname, 'stack.cjs');

const args = process.argv.slice(2);
const extended = args.includes('--extended');
const parallelIndex = args.indexOf('--parallel');
const parallel = parallelIndex === -1 ? 1 : Number(args[parallelIndex + 1]);
const areaArgs = args.filter((arg, index) => !arg.startsWith('--') && !(parallelIndex !== -1 && index === parallelIndex + 1));
if (!Number.isInteger(parallel) || parallel < 1 || parallel > SHARDS.length) {
    console.error(`--parallel은 1~${SHARDS.length} 사이 정수다`);
    process.exit(2);
}
let areas;
try {
    areas = selectedAreas(areaArgs.join(','));
} catch (error) {
    console.error(error.message);
    process.exit(2);
}

function plan() {
    if (parallel === 1 || extended) return [[...areas]];
    const shards = SHARDS.map((shard) => shard.filter((area) => areas.has(area))).filter((shard) => shard.length > 0);
    const buckets = Array.from({ length: Math.min(parallel, shards.length) }, () => []);
    shards.forEach((shard, index) => buckets[index % buckets.length].push(...shard));
    return buckets;
}

// --plan: 무엇이 돌지만 보여 주고 끝낸다. Docker를 건드리지 않는다.
if (args.includes('--plan')) {
    for (const [index, bucket] of plan().entries()) console.log(`스택 ${index + 1}: ${extended ? 'extended' : 'core'} ${bucket.join(' ')}`);
    process.exit(0);
}

// 비밀값 검사는 저장소 전체에 한 번이면 된다.
if (spawnSync(process.execPath, [resolve(__dirname, 'secrets.cjs')], { cwd: ROOT, stdio: 'inherit' }).status !== 0) process.exit(1);

const baseId = process.env.AUDIT_RUN_ID || `local-${Date.now().toString(36)}`;
const mode = extended ? 'extended' : 'core';

if (parallel === 1 || extended) {
    if (extended && parallel > 1) console.log('확장 점검은 스택 하나로 돈다(프로세스 증감을 재기 때문).');
    const result = spawnSync(process.execPath, [STACK, 'run', mode, ...areas], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, AUDIT_RUN_ID: baseId } });
    process.exit(result.status ?? 1);
}

// 선택한 영역이 들어 있는 묶음만, 묶음 단위로 스택 N개에 고르게 나눈다.
const buckets = plan();

console.log(`스택 ${buckets.length}개로 나눠 돈다: ${buckets.map((bucket) => bucket.join('+')).join(' | ')}`);
const runs = buckets.map((bucket, index) => new Promise((done) => {
    const runId = `${baseId}-p${index + 1}`;
    const child = spawn(process.execPath, [STACK, 'run', 'core', ...bucket], { cwd: ROOT, env: { ...process.env, AUDIT_RUN_ID: runId } });
    const label = `[${bucket.join('+')}]`;
    for (const stream of [child.stdout, child.stderr]) {
        let rest = '';
        stream.on('data', (chunk) => {
            const lines = (rest + chunk.toString('utf8')).split(/\r?\n/);
            rest = lines.pop();
            for (const line of lines) if (line.trim()) process.stdout.write(`${label} ${line}\n`);
        });
    }
    child.on('close', (code) => done({ bucket, runId, code: code ?? 1 }));
}));

Promise.all(runs).then((results) => {
    console.log('\n결과');
    for (const { bucket, runId, code } of results) {
        console.log(`  ${code === 0 ? '통과' : '실패'}  ${bucket.join('+')}  (증거: e2e/artifacts/audit/${runId}/)`);
    }
    process.exit(results.every((result) => result.code === 0) ? 0 : 1);
});
