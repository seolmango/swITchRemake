#!/usr/bin/env node
'use strict';
/**
 * 로컬 개발 서버를 한 터미널에서 전부 띄운다. Ctrl+C 한 번이면 전부 내려간다.
 *
 *   [match]   매칭 서버 :3000 (코드를 고치면 다시 뜬다)
 *   [cluster] 게이트웨이 :4100 + 감독자 + 인게임 서버 (서버 코드를 고치면 이 프로세스만 다시 띄운다)
 *   [client]  Vite :5173 (화면은 저장하면 바로 바뀐다)
 *
 * 띄우기 전에 .env, DB·Redis 접속, 남은 마이그레이션을 확인해 무엇을 먼저 해야 하는지 알려 준다.
 * 하나만 따로 띄우려면 match:dev / cluster:start / `npm run dev -w client`를 쓴다.
 */
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const net = require('node:net');
const { resolve } = require('node:path');
const { parseEnv, validate } = require('./env/lib.cjs');

const ROOT = resolve(__dirname, '..');
const ENV_FILE = resolve(ROOT, '.env');
const color = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);

function fail(message) {
    console.error(color(31, `✗ ${message}`));
    process.exit(1);
}

function reachable(host, port) {
    return new Promise((done) => {
        const socket = net.connect({ host, port: Number(port), timeout: 1500 });
        socket.once('connect', () => { socket.destroy(); done(true); });
        socket.once('error', () => done(false));
        socket.once('timeout', () => { socket.destroy(); done(false); });
    });
}

async function pendingMigrations(values) {
    try {
        const postgres = require('postgres');
        const sql = postgres({
            host: values.get('DB_HOST'), port: Number(values.get('DB_PORT') || 5432),
            user: values.get('DB_USER'), password: values.get('DB_PASSWORD'), database: values.get('DB_NAME'),
            max: 1, connect_timeout: 3, onnotice: () => {},
        });
        const defined = JSON.parse(readFileSync(resolve(ROOT, 'server-match/drizzle/meta/_journal.json'), 'utf8')).entries.length;
        let applied = 0;
        try {
            [{ applied }] = await sql`select count(*)::int as applied from drizzle.__drizzle_migrations`;
        } catch {
            applied = 0; // 한 번도 마이그레이션하지 않은 DB
        } finally {
            await sql.end({ timeout: 1 });
        }
        return defined - applied;
    } catch {
        return null; // 확인하지 못했다. 서버가 직접 알려 줄 것이다
    }
}

async function preflight() {
    if (!existsSync(ENV_FILE)) fail('.env가 없다. 먼저 `npm run setup`');
    const values = parseEnv(readFileSync(ENV_FILE, 'utf8'));
    const { errors } = validate(values, 'dev');
    if (errors.length > 0) {
        for (const message of errors) console.error(`  ${message}`);
        fail('.env에 서버가 기동을 거부할 값이 있다. `npm run env:check`로 확인한다');
    }
    const [db, redis] = await Promise.all([
        reachable(values.get('DB_HOST') || 'localhost', values.get('DB_PORT') || 5432),
        reachable(values.get('REDIS_HOST') || 'localhost', values.get('REDIS_PORT') || 6379),
    ]);
    if (!db || !redis) fail(`${!db ? 'PostgreSQL' : 'Redis'}에 닿지 않는다. 먼저 \`npm run db:up\``);
    const pending = await pendingMigrations(values);
    if (pending > 0) fail(`DB 마이그레이션 ${pending}개가 남았다. 먼저 \`npm run db:migrate\``);
    if (!existsSync(resolve(ROOT, 'shared/dist/index.js'))) {
        console.log('shared를 빌드한다…');
        if (spawnSync('npm run build -w shared', { cwd: ROOT, stdio: 'inherit', shell: true }).status !== 0) fail('shared 빌드 실패');
    }
}

const PROCESSES = [
    { name: 'match', color: 35, args: ['run', 'dev', '-w', 'server-match'] },
    { name: 'cluster', color: 36, args: ['run', 'cluster:start'] },
    { name: 'client', color: 33, args: ['run', 'dev', '-w', 'client'] },
];
const children = [];
let stopping = false;

function stopAll(code) {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
        if (child.exitCode !== null) continue;
        // npm이 띄운 손자 프로세스까지 내려야 포트가 풀린다.
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 이미 끝났다 */ }
    }
    setTimeout(() => process.exit(code), 500);
}

function start({ name, color: code, args }) {
    // 셸을 거쳐야 Windows에서 npm.cmd를 찾는다. 인자는 이 파일에 고정된 값뿐이다.
    const child = spawn(`npm ${args.join(' ')}`, {
        cwd: ROOT,
        shell: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, FORCE_COLOR: '1' },
    });
    const label = color(code, `[${name}]`.padEnd(9));
    for (const stream of [child.stdout, child.stderr]) {
        let buffer = '';
        stream.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            for (const line of lines) process.stdout.write(`${label} ${line}\n`);
        });
    }
    child.on('exit', (status) => {
        if (stopping) return;
        console.error(color(31, `[${name}] 종료 (code=${status}). 나머지도 내린다.`));
        stopAll(status ?? 1);
    });
    children.push(child);
}

preflight().then(() => {
    console.log(color(32, '✓ 준비 완료. http://localhost:5173 (Ctrl+C로 전부 종료)\n'));
    for (const entry of PROCESSES) start(entry);
    process.on('SIGINT', () => stopAll(0));
    process.on('SIGTERM', () => stopAll(0));
}).catch((error) => fail(error.message));
