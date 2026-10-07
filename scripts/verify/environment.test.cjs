'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { assertNoInheritedDeploymentSettings } = require('./environment.cjs');

test('deployment destinations and credentials reject before any Docker invocation', { timeout: 10_000 }, () => {
    const names = ['DB_HOST', 'DB_PASSWORD', 'REDIS_HOST', 'REDIS_PASSWORD', 'SMTP_USER', 'SMTP_PASSWORD',
        'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'JWT_GUEST_REFRESH_SECRET', 'SESSION_IP_SECRET',
        'MFA_TOTP_ENCRYPTION_KEY', 'REPLAY_SIGNING_KEY', 'REPLAY_SIGNING_PUBLIC_KEYS', 'AZURE_CLIENT_SECRET',
        'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'DATABASE_URL', 'PGHOST', 'PGPASSWORD',
        'REDISCLI_AUTH', 'S3_ACCESS_KEY', 'E2E_BASE_URL', 'REPLAY_STORE', 'EMAIL_TRANSPORT'];
    for (const name of names) {
        const environment = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AUDIT_RUN_ID: 'guard-probe', [name]: 'synthetic_guard_probe' };
        const script = `const cp=require('node:child_process');let dockerCalled=false;cp.spawnSync=()=>{dockerCalled=true;throw Error('Unexpected Docker invocation')};try{require(${JSON.stringify(require.resolve('./stack.cjs'))});process.exitCode=2}catch(e){console.log(JSON.stringify({dockerCalled,rejected:e.message==='Audit refused inherited deployment setting: '+${JSON.stringify(name)},leaked:e.message.includes('synthetic_guard_probe')}));process.exitCode=1}`;
        const result = spawnSync(process.execPath, ['-e', script], { env: environment, encoding: 'utf8', timeout: 2_000 });
        assert.equal(result.status, 1, name);
        assert.deepEqual(JSON.parse(result.stdout), { dockerCalled: false, rejected: true, leaked: false }, name);
    }
});

test('empty deployment values and ordinary runtime path metadata are allowed', () => {
    assert.doesNotThrow(() => assertNoInheritedDeploymentSettings({ PATH: 'runtime-path', HOME: 'home',
        DOCKER_CONFIG: 'docker-config-path', AUDIT_RUN_ID: 'guard-probe', AZURE_EXTENSION_DIR: '',
        DB_PASSWORD: '', REDIS_PASSWORD: '', SMTP_PASSWORD: '', JWT_ACCESS_SECRET: '' }));
});

test('remote Docker context refuses engine access and cleanup even with a preexisting run file', { timeout: 3_000 }, () => {
    const script = `const cp=require('node:child_process');const fs=require('node:fs');let calls=0;fs.existsSync=()=>true;cp.spawnSync=()=>{calls++;return {status:0,stdout:'tcp://remote.invalid:2376\\n',stderr:''}};require(${JSON.stringify(require.resolve('./stack.cjs'))});console.log(JSON.stringify({calls}));`;
    const result = spawnSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AUDIT_RUN_ID: 'guard-probe' }, encoding: 'utf8', timeout: 2_000 });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { calls: 1 }, 'only local context metadata may be inspected');
    assert.match(result.stderr, /Audit refuses non-local Docker contexts/);
});

test('reused run identifier refuses cleanup of another launch', { timeout: 3_000 }, () => {
    const script = `const cp=require('node:child_process');const fs=require('node:fs');let calls=0;fs.existsSync=()=>true;cp.spawnSync=()=>{calls++;return {status:0,stdout:'unix:///var/run/docker.sock\\n',stderr:''}};require(${JSON.stringify(require.resolve('./stack.cjs'))});console.log(JSON.stringify({calls}));`;
    const result = spawnSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AUDIT_RUN_ID: 'guard-probe' }, encoding: 'utf8', timeout: 2_000 });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { calls: 1 }, 'no engine mutation or cleanup after identifier refusal');
    assert.match(result.stderr, /Run identifier already exists/);
});

for (const collectionFails of [false, true]) test(`failed build cleans its own run with collection ${collectionFails ? 'failed' : 'successful'}`, { timeout: 3_000 }, () => {
    const script = `
        const cp=require('node:child_process'),fs=require('node:fs');
        const read=fs.readFileSync,exists=fs.existsSync;let runtime,downs=0,exclusive=false;
        fs.existsSync=(p)=>String(p).endsWith('runtime.env')?Boolean(runtime):exists(p);
        fs.mkdirSync=()=>{};
        fs.writeFileSync=(p,text,options)=>{if(String(p).endsWith('runtime.env')){runtime=text;exclusive=options.flag==='wx'}};
        fs.readFileSync=(p,...args)=>String(p).endsWith('runtime.env')?runtime:read(p,...args);
        fs.readdirSync=()=>[];
        fs.unlinkSync=()=>{runtime=undefined};
        cp.spawnSync=(command,args)=>{
            let stdout='';
            if(args[0]==='context')stdout='unix:///var/run/docker.sock\\n';
            else if(args[0]==='version')stdout=JSON.stringify({Client:{Version:'test'},Server:{Version:'test'}});
            else if(args[0]==='build')return {status:1,stdout:'',stderr:'synthetic build failure\\n'};
            else if(${collectionFails}&&args[0]==='compose'&&args.includes('ps'))return {status:1,stdout:'',stderr:'synthetic collection failure\\n'};
            else if(args[0]==='network'&&args[1]==='inspect')stdout='true';
            else if(args.includes('down'))downs++;
            return {status:0,stdout,stderr:''};
        };
        require(${JSON.stringify(require.resolve('./stack.cjs'))});
        console.log(JSON.stringify({downs,fileRemoved:runtime===undefined,exclusive}));`;
    const result = spawnSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, AUDIT_RUN_ID: 'guard-probe' }, encoding: 'utf8', timeout: 2_000 });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), { downs: 1, fileRemoved: true, exclusive: true });
    assert.match(result.stderr, /Docker operation failed \(1\): build/);
    if (collectionFails) assert.match(result.stderr, /Audit evidence collection failed/);
});
