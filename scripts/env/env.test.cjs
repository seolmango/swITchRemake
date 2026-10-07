'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');
const { VARS, BY_KEY } = require('./schema.cjs');
const { parseEnv, renderProfile, validate } = require('./lib.cjs');

const ROOT = resolve(__dirname, '..', '..');
const CLI = join(__dirname, 'cli.cjs');

const SOURCES = ['server-match/src', 'server-game/src', 'server-gateway/src', 'server-supervisor/src', 'server-match/drizzle.config.ts'];
// 환경 변수를 읽는 모양들: process.env.X, env.X, process.env['X'], get('X'), optional('X') …
const READ = /(?:process\.env\.|env\.|process\.env\[')([A-Z][A-Z0-9_]+)|(?:get|getOrThrow|optional|required|num|list|read|env)(?:<[a-z]+>)?\('([A-Z][A-Z0-9_]{2,})'/g;

function sourceFiles(path) {
    const full = join(ROOT, path);
    if (statSync(full).isFile()) return [full];
    return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
        const child = join(path, entry.name);
        if (entry.isDirectory()) return sourceFiles(child);
        return /\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name) ? [join(ROOT, child)] : [];
    });
}

/** 서버 코드가 읽는 환경 변수 이름을 모은다. 읽는 방식이 늘어나면 READ도 늘린다. */
function namesReadByServers() {
    const names = new Set();
    for (const file of SOURCES.flatMap(sourceFiles)) {
        for (const match of readFileSync(file, 'utf8').matchAll(READ)) names.add(match[1] ?? match[2]);
    }
    // 설정이 아닌 상수와 테스트·이미지 전용 스위치.
    for (const ignored of ['PROD', 'SWITCH_SKIP_ENV_FILE']) names.delete(ignored);
    return names;
}

test('every variable the servers read is described in schema.cjs', () => {
    const missing = [...namesReadByServers()].filter((name) => !BY_KEY.has(name));
    assert.deepEqual(missing, [], `schema.cjs에 추가한다: ${missing.join(', ')}`);
});

test('schema.cjs has no variable that nothing reads', () => {
    const read = namesReadByServers();
    const stale = VARS.filter((entry) => !entry.services.includes('compose') && !read.has(entry.key)).map((entry) => entry.key);
    assert.deepEqual(stale, [], `코드가 더 이상 읽지 않는다: ${stale.join(', ')}`);
});

test('.env.example and docs/configuration.md are generated from the schema', () => {
    const result = spawnSync(process.execPath, [CLI, 'docs', '--check'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
});

test('a freshly generated file passes its own check in both profiles', () => {
    assert.deepEqual(validate(parseEnv(renderProfile('dev')), 'dev').errors, []);
    const deploy = renderProfile('deploy', { domain: 'game.example.com', smtpUser: 'a@example.com', smtpPassword: 'x' });
    assert.deepEqual(validate(parseEnv(deploy), 'deploy').errors, []);
});

test('two generated files never share a secret', () => {
    const a = parseEnv(renderProfile('dev'));
    const b = parseEnv(renderProfile('dev'));
    for (const key of ['JWT_ACCESS_SECRET', 'SESSION_IP_ENCRYPTION_KEY', 'REPLAY_SIGNING_KEY']) assert.notEqual(a.get(key), b.get(key));
});

test('check rejects the mistakes the servers would refuse at startup', () => {
    const values = parseEnv(renderProfile('dev'));
    values.set('JWT_REFRESH_SECRET', values.get('JWT_ACCESS_SECRET'));
    values.set('SESSION_IP_ENCRYPTION_KEY', 'not-a-key');
    values.set('GAME_ALLOWED_ORIGINS', 'http://localhost:5173/');
    values.set('APP_ENV', 'prod');
    const { errors } = validate(values, 'dev');
    for (const key of ['JWT_REFRESH_SECRET', 'SESSION_IP_ENCRYPTION_KEY', 'GAME_ALLOWED_ORIGINS', 'EMAIL_TRANSPORT']) {
        assert.ok(errors.some((message) => message.startsWith(key)), `${key} 오류가 없다: ${errors.join(' / ')}`);
    }
    assert.ok(errors.every((message) => !message.includes(values.get('JWT_ACCESS_SECRET'))), '오류 문구에 비밀값이 찍혔다');
});

test('a replay public key that does not match the private key is reported', () => {
    const values = parseEnv(renderProfile('dev'));
    values.set('REPLAY_SIGNING_PUBLIC_KEYS', parseEnv(renderProfile('dev')).get('REPLAY_SIGNING_PUBLIC_KEYS'));
    assert.ok(validate(values, 'dev').warnings.some((message) => message.startsWith('REPLAY_SIGNING_PUBLIC_KEYS')));
});

test('setup keeps existing values and only appends missing required entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'switch-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'DB_PASSWORD=keep-me\nCUSTOM=1\n');
    const result = spawnSync(process.execPath, [CLI, 'setup', 'dev', '--file', file], { encoding: 'utf8' });
    assert.notEqual(result.status, null, result.stderr);
    const values = parseEnv(readFileSync(file, 'utf8'));
    assert.equal(values.get('DB_PASSWORD'), 'keep-me');
    assert.equal(values.get('CUSTOM'), '1');
    assert.ok(values.get('JWT_ACCESS_SECRET').length >= 32);
    assert.equal(values.has('SMTP_HOST'), false, '선택 항목은 덧붙이지 않는다');
});
