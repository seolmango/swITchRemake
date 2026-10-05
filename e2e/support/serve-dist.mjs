// 현재 소스로 빌드한 client/dist를 띄우고, /api·/map-bundles만 이미 떠 있는 스택으로 넘긴다.
// 내부 스택의 web 컨테이너는 이미지를 다시 굽기 전까지 옛 번들을 서빙한다. UI를 잴 때
// 그걸 재면 이미 고친 결함을 다시 보게 된다 — e2e/live/ui-matrix.spec.ts 참고.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../client/dist', import.meta.url));
const PORT = Number(process.env.PORT || 5199);
// 백엔드 주소. 기본은 로컬 내부 스택(npm run internal:up)의 nginx다.
const upstream = new URL(process.env.SERVE_DIST_API || 'http://127.0.0.1:8080');
const API = { host: upstream.hostname, port: Number(upstream.port || 80) };

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wasm': 'application/wasm',
};

const proxy = (req, res) => {
    const upstream = httpRequest({ ...API, method: req.method, path: req.url, headers: { ...req.headers, host: `${API.host}:${API.port}` } }, (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end('upstream down'); });
    req.pipe(upstream);
};

createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/map-bundles')) return proxy(req, res);
    // 서비스 워커는 감사에 방해만 된다 — 캐시가 낀 화면을 재게 된다.
    if (url.pathname === '/sw.js') { res.writeHead(404); return res.end(); }
    const rel = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    for (const candidate of [join(ROOT, rel), join(ROOT, 'index.html')]) {
        try {
            const body = await readFile(candidate);
            res.writeHead(200, { 'content-type': MIME[extname(candidate)] || 'application/octet-stream', 'cache-control': 'no-store' });
            return res.end(body);
        } catch { /* 다음 후보 */ }
    }
    res.writeHead(404); res.end('not found');
}).listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT} (api -> ${API.host}:${API.port})`));
