#!/usr/bin/env node
'use strict';
/**
 * Docker 배포 스택(deploy/compose.yml) 실행기.
 *
 *   npm run stack:up       .env.deploy 검사 → 이미지 빌드 → 실행 (SWITCH_DOMAIN이 있으면 HTTPS까지)
 *   npm run stack:down     멈춘다. 데이터 볼륨은 남는다
 *   npm run stack:logs     로그를 따라간다 (뒤에 서비스 이름을 붙일 수 있다)
 *   npm run stack:ps       상태
 *
 * docker compose를 직접 불러도 되지만 그때는 `--env-file .env.deploy`와, 도메인이 있으면
 * `--profile https`를 잊지 말아야 한다. 이 스크립트가 그 둘과 BUILD_ID(지금 커밋)를 챙긴다.
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parseEnv, validate } = require('./env/lib.cjs');

const ROOT = resolve(__dirname, '..');
const ENV_FILE = resolve(ROOT, '.env.deploy');
const [command = 'ps', ...rest] = process.argv.slice(2);

if (!existsSync(ENV_FILE)) {
    console.error('.env.deploy가 없다. 먼저 `npm run setup -- deploy`');
    process.exit(1);
}
const values = parseEnv(readFileSync(ENV_FILE, 'utf8'));

function git(...args) {
    const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : '';
}

const env = { ...process.env };
const revision = git('rev-parse', 'HEAD');
if (revision) {
    const dirty = git('status', '--porcelain') !== '';
    env.STACK_REVISION = revision;
    env.STACK_BUILD_ID = `${revision.slice(0, 7)}${dirty ? '-dirty' : ''}`;
}

const compose = ['compose', '--env-file', ENV_FILE, '-f', resolve(ROOT, 'deploy', 'compose.yml')];
if (values.get('SWITCH_DOMAIN')) compose.push('--profile', 'https');

const run = (args) => {
    const result = spawnSync('docker', [...compose, ...args], { cwd: ROOT, env, stdio: 'inherit' });
    if (result.error) {
        console.error('docker를 실행하지 못했다. Docker가 설치돼 있고 켜져 있는지 확인한다.');
        process.exit(1);
    }
    return result.status ?? 1;
};

switch (command) {
    case 'up': {
        const { errors, warnings } = validate(values, 'deploy');
        for (const message of warnings) console.log(`경고  ${message}`);
        if (errors.length > 0) {
            for (const message of errors) console.error(`오류  ${message}`);
            console.error('.env.deploy를 고친 뒤 다시 실행한다(npm run env:check -- deploy).');
            process.exit(1);
        }
        if (env.STACK_BUILD_ID) console.log(`BUILD_ID=${env.STACK_BUILD_ID}`);
        const status = run(['up', '-d', '--build', '--wait', '--wait-timeout', '300', ...rest]);
        if (status === 0) {
            const domain = values.get('SWITCH_DOMAIN');
            const url = domain ? `https://${domain}` : `http://localhost:${values.get('WEB_PORT') || '8080'}`;
            console.log(`\n실행 중: ${url}`);
        }
        process.exit(status);
        break;
    }
    case 'down': process.exit(run(['down', ...rest])); break;
    case 'logs': process.exit(run(['logs', '-f', '--tail', '100', ...rest])); break;
    case 'ps': process.exit(run(['ps', ...rest])); break;
    case 'restart': process.exit(run(['restart', ...rest])); break;
    default:
        console.error('사용법: node scripts/deploy-stack.cjs <up|down|logs|ps|restart> [서비스...]');
        process.exit(2);
}
