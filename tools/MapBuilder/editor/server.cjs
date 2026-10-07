#!/usr/bin/env node
'use strict';
/**
 * 맵 에디터 서버. `npm run map:editor`로 띄우고 브라우저에서 http://127.0.0.1:5180 을 연다.
 *
 * 하는 일은 셋뿐이다.
 *   - 에디터 화면과 타일 이미지(tools/MapBuilder/asset)를 내준다
 *   - tools/MapBuilder/map/의 맵(JSON+CSV)을 읽고 쓴다
 *   - "빌드"를 누르면 builder.py로 번들을 만들어 server-game/maps/server_maps.json에 복사한다
 *
 * 이 머신(127.0.0.1)에서만 열린다. 파일 이름은 영문·숫자·_- 만 받아 map/ 밖을 쓸 수 없다.
 */
const http = require('node:http');
const { spawn } = require('node:child_process');
const { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { extname, join, resolve } = require('node:path');

const BUILDER = resolve(__dirname, '..');
const ROOT = resolve(BUILDER, '..', '..');
const MAP_DIR = join(BUILDER, 'map');
const ASSET_DIR = join(BUILDER, 'asset');
const BUNDLE_TARGET = join(ROOT, 'server-game', 'maps', 'server_maps.json');
const PORT = Number(process.env.MAP_EDITOR_PORT || 5180);
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
    return new Promise((done, fail) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 5 * 1024 * 1024) { fail(new Error('too large')); req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
        req.on('error', fail);
    });
}

function listMaps() {
    return readdirSync(MAP_DIR).filter((name) => name.endsWith('.json')).sort().map((name) => {
        const info = JSON.parse(readFileSync(join(MAP_DIR, name), 'utf8'));
        return { file: name.slice(0, -5), name: info.name, size: info.size, training: Boolean(info.training) };
    });
}

function python() {
    const venv = process.platform === 'win32' ? join(BUILDER, '.venv', 'Scripts', 'python.exe') : join(BUILDER, '.venv', 'bin', 'python');
    if (existsSync(venv)) return venv;
    return process.platform === 'win32' ? 'python' : 'python3';
}

function build() {
    return new Promise((done) => {
        const child = spawn(python(), ['builder.py', '-t', 'build', '-s', 'setting.json'], {
            cwd: BUILDER, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
        let log = '';
        child.stdout.on('data', (chunk) => { log += chunk; });
        child.stderr.on('data', (chunk) => { log += chunk; });
        child.on('error', (error) => done({ ok: false, log: `${log}\n${python()}을 실행하지 못했다: ${error.message}\ntools/MapBuilder/README.md의 설치 순서를 따른다.` }));
        child.on('close', (code) => {
            const built = join(BUILDER, 'build', 'server_maps.json');
            if (code !== 0 || !existsSync(built)) { done({ ok: false, log }); return; }
            const before = existsSync(BUNDLE_TARGET) ? readFileSync(BUNDLE_TARGET, 'utf8') : '';
            copyFileSync(built, BUNDLE_TARGET);
            const after = readFileSync(BUNDLE_TARGET, 'utf8');
            done({ ok: true, changed: before !== after, log });
        });
    });
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const path = decodeURIComponent(url.pathname);

        if (req.method === 'GET' && (path === '/' || /^\/[a-z]+\.(html|js|css)$/.test(path))) {
            const file = join(__dirname, path === '/' ? 'index.html' : path.slice(1));
            if (!existsSync(file)) return send(res, 404, { error: 'not found' });
            return send(res, 200, readFileSync(file), MIME[extname(file)]);
        }
        if (req.method === 'GET' && path.startsWith('/asset/')) {
            const name = path.slice('/asset/'.length);
            if (!/^[A-Za-z0-9_-]+\.png$/.test(name) || !existsSync(join(ASSET_DIR, name))) return send(res, 404, { error: 'not found' });
            return send(res, 200, readFileSync(join(ASSET_DIR, name)), 'image/png');
        }
        if (req.method === 'GET' && path === '/api/setting') {
            return send(res, 200, readFileSync(join(BUILDER, 'setting.json'), 'utf8'));
        }
        if (req.method === 'GET' && path === '/api/maps') return send(res, 200, listMaps());

        const mapMatch = /^\/api\/maps\/([^/]+)$/.exec(path);
        if (mapMatch) {
            const file = mapMatch[1];
            if (!SAFE_NAME.test(file)) return send(res, 400, { error: '파일 이름은 영문·숫자·_- 만 쓴다' });
            const jsonPath = join(MAP_DIR, `${file}.json`);
            if (req.method === 'GET') {
                if (!existsSync(jsonPath)) return send(res, 404, { error: 'not found' });
                const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
                if (!SAFE_NAME.test(String(json.data ?? '').replace(/\.csv$/, ''))) return send(res, 400, { error: 'data 파일 이름이 이상하다' });
                return send(res, 200, { json, csv: readFileSync(join(MAP_DIR, json.data), 'utf8') });
            }
            if (req.method === 'PUT') {
                const { json, csv } = JSON.parse(await readBody(req));
                if (typeof csv !== 'string' || typeof json !== 'object' || json === null) return send(res, 400, { error: 'json과 csv가 필요하다' });
                const data = `${file}.csv`;
                writeFileSync(join(MAP_DIR, data), csv.endsWith('\n') ? csv : `${csv}\n`);
                writeFileSync(jsonPath, `${JSON.stringify({ ...json, data }, null, 4)}\n`);
                return send(res, 200, { ok: true, file });
            }
        }
        if (req.method === 'POST' && path === '/api/build') return send(res, 200, await build());
        send(res, 404, { error: 'not found' });
    } catch (error) {
        send(res, 500, { error: String(error.message ?? error) });
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`맵 에디터: http://127.0.0.1:${PORT}  (Ctrl+C로 종료)`);
});
