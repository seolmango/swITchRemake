#!/usr/bin/env node
'use strict';
/**
 * 환경 파일 도구. 의존성 없이 Node만으로 돈다(서버에 npm install 전에도 쓸 수 있게).
 *
 *   node scripts/env/cli.cjs setup [dev|deploy] [--force] [--yes] [--domain <도메인>] [--file <경로>]
 *   node scripts/env/cli.cjs check [dev|deploy] [--file <경로>]
 *   node scripts/env/cli.cjs docs [--check]
 *
 * setup은 기존 값을 절대 바꾸지 않는다. 없는 필수 항목만 덧붙인다. --force일 때만 새로 만들고
 * 기존 파일은 `.bak-<시각>`으로 남긴다.
 */
const { copyFileSync, existsSync, readFileSync, writeFileSync, appendFileSync } = require('node:fs');
const { resolve } = require('node:path');
const readline = require('node:readline/promises');
const { PROFILES, parseEnv, renderProfile, missingEntries, validate, renderDocs, wrap } = require('./lib.cjs');

const ROOT = resolve(__dirname, '..', '..');

function parseArgs(argv) {
    const args = { positional: [], flags: {} };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) { args.positional.push(arg); continue; }
        const name = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--') && ['domain', 'file', 'smtp-user'].includes(name)) {
            args.flags[name] = next;
            i++;
        } else {
            args.flags[name] = true;
        }
    }
    return args;
}

function profileOf(args) {
    const profile = args.positional[1] ?? 'dev';
    if (!PROFILES[profile]) {
        console.error(`알 수 없는 프로필: ${profile} (dev 또는 deploy)`);
        process.exit(2);
    }
    return profile;
}

function fileOf(args, profile) {
    return resolve(ROOT, args.flags.file ?? PROFILES[profile].file);
}

function report(file, profile) {
    const { errors, warnings } = validate(parseEnv(readFileSync(file, 'utf8')), profile);
    for (const message of warnings) console.log(`  경고  ${message}`);
    for (const message of errors) console.log(`  오류  ${message}`);
    if (errors.length === 0) console.log(`  ✓ ${relative(file)} 통과${warnings.length ? ` (경고 ${warnings.length})` : ''}`);
    return errors.length === 0;
}

const relative = (file) => file.startsWith(ROOT) ? file.slice(ROOT.length + 1).replace(/\\/g, '/') : file;

async function askDeployOptions(args) {
    const options = { domain: args.flags.domain, smtpUser: args.flags['smtp-user'] };
    if (args.flags.yes || !process.stdin.isTTY) return options;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        console.log('배포 설정을 만든다. 엔터를 누르면 괄호 안 값을 쓴다.\n');
        if (options.domain === undefined) {
            const answer = (await rl.question('공개할 도메인 (예: game.example.com, 비우면 이 머신에서만 http://localhost:8080): ')).trim();
            options.domain = answer || undefined;
        }
        if (options.smtpUser === undefined) {
            const answer = (await rl.question('메일 보낼 SMTP 계정 (비우면 메일 없이 — 가입 인증을 끝낼 수 없다): ')).trim();
            options.smtpUser = answer || undefined;
        }
        if (options.smtpUser) {
            options.smtpPassword = (await rl.question('SMTP 비밀번호 (Gmail은 앱 비밀번호): ')).trim();
        }
    } finally {
        rl.close();
    }
    return options;
}

async function setup(args) {
    const profile = profileOf(args);
    const file = fileOf(args, profile);
    const legacy = resolve(ROOT, '.env.internal');

    if (existsSync(file) && args.flags.force) {
        const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        copyFileSync(file, backup);
        console.log(`기존 파일을 ${relative(backup)}로 남겼다.`);
    } else if (!existsSync(file) && profile === 'deploy' && !args.flags.file && existsSync(legacy)) {
        // 예전 내부 테스트 설정을 이어받는다. 암호화 키와 DB 비밀번호가 그대로 있어야 기존 볼륨을 계속 쓴다.
        writeFileSync(file, readFileSync(legacy, 'utf8').trimEnd()
            + '\n\n# 예전 compose.internal.yml 볼륨을 그대로 쓰기 위한 프로젝트 이름\nCOMPOSE_PROJECT_NAME=switch-internal\n', { mode: 0o600 });
        console.log('.env.internal을 .env.deploy로 이어받았다(값은 그대로). 원본은 지워도 된다.');
    }

    if (!existsSync(file) || args.flags.force) {
        const options = profile === 'deploy' ? await askDeployOptions(args) : {};
        writeFileSync(file, renderProfile(profile, options), { mode: 0o600 });
        console.log(`${relative(file)}를 만들었다. 비밀값은 새로 생성했다.`);
    } else {
        const existing = parseEnv(readFileSync(file, 'utf8'));
        const added = missingEntries(profile, existing);
        if (added.length === 0) {
            console.log(`${relative(file)}가 이미 있고 빠진 항목이 없다. 값은 바꾸지 않았다.`);
        } else {
            const lines = ['', `# ----- npm run setup이 ${new Date().toISOString().slice(0, 10)}에 덧붙인 항목 -----`];
            for (const entry of added) {
                for (const text of wrap(entry.desc)) lines.push(`# ${text}`);
                lines.push(`${entry.key}=${entry.value}`);
            }
            appendFileSync(file, lines.join('\n') + '\n');
            console.log(`${relative(file)}에 빠진 항목 ${added.length}개를 덧붙였다: ${added.map((e) => e.key).join(', ')}`);
        }
    }

    console.log('\n검사:');
    const ok = report(file, profile);
    console.log('\n다음 단계:');
    if (profile === 'dev') {
        console.log('  npm run db:up && npm run db:migrate && npm run dev');
    } else {
        console.log('  npm run stack:up        # 이미지 빌드 후 실행');
        console.log('  자세한 것은 docs/deployment.md');
    }
    if (!ok) process.exitCode = 1;
}

function check(args) {
    const profile = profileOf(args);
    const file = fileOf(args, profile);
    if (!existsSync(file)) {
        console.error(`${relative(file)}가 없다. 먼저 npm run setup${profile === 'deploy' ? ' -- deploy' : ''}`);
        process.exit(1);
    }
    if (!report(file, profile)) process.exitCode = 1;
}

function docs(args) {
    const outputs = [
        [resolve(ROOT, '.env.example'), renderProfile('dev', {}, { example: true })],
        [resolve(ROOT, 'docs', 'configuration.md'), renderDocs()],
    ];
    let stale = false;
    for (const [file, content] of outputs) {
        const current = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
        if (current === content) continue;
        stale = true;
        if (args.flags.check) console.error(`${relative(file)}가 schema.cjs와 다르다. npm run env:docs로 다시 만든다.`);
        else { writeFileSync(file, content); console.log(`${relative(file)} 갱신`); }
    }
    if (args.flags.check && stale) process.exitCode = 1;
    else if (!stale) console.log('설정 문서가 최신이다.');
}

const args = parseArgs(process.argv.slice(2));
const command = args.positional[0];
if (command === 'setup') setup(args).catch((error) => { console.error(error); process.exit(1); });
else if (command === 'check') check(args);
else if (command === 'docs') docs(args);
else {
    console.error('사용법: node scripts/env/cli.cjs <setup|check|docs> [dev|deploy] [옵션]');
    process.exit(2);
}
