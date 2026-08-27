"use strict";
/**
 * swITch 게이트웨이.
 *
 * 사용자가 아는 주소는 여기 하나뿐이다. 자기가 몇 번 인게임 서버에 붙어 있는지, 서버가 몇 대인지,
 * 방금 늘었는지 줄었는지 알 필요가 없다 — 그걸 몰라도 되게 만드는 것이 이 프로세스의 존재 이유다.
 *
 * 하는 일은 두 가지뿐이다.
 *
 *   /game-ws/{serverId}  → 그 서버로 WebSocket 업그레이드를 넘긴다 (정확히 그 한 대)
 *   /map-bundles/*       → 한가한 서버 아무 곳으로 넘긴다 (해시로 주소가 정해지는 불변 데이터)
 *
 * 어디로 넘길지는 Redis의 heartbeat가 알려 준다. 정적 설정이 없으므로 감독자가 프로세스를
 * 늘리거나 줄여도 여기를 고칠 일이 없다.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
const node_net_1 = require("node:net");
const ioredis_1 = __importDefault(require("ioredis"));
const shared_1 = require("shared");
const registry_view_1 = require("./registry-view");
const routing_1 = require("./routing");
const log = (message) => { console.log(`[gateway] ${message}`); };
const env = (name, fallback) => process.env[name]?.trim() || fallback;
const PORT = Number(env('GATEWAY_PORT', '4100'));
const HOST = env('GATEWAY_HOST', '0.0.0.0');
const APP_ENV = env('APP_ENV', 'dev');
async function main() {
    const redis = new ioredis_1.default({
        host: env('REDIS_HOST', 'localhost'),
        port: Number(env('REDIS_PORT', '6379')),
        ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
        lazyConnect: true,
        maxRetriesPerRequest: 2,
    });
    await redis.connect();
    const view = new registry_view_1.RegistryView({
        redis,
        keys: (0, shared_1.makeKeys)(APP_ENV),
        logger: (message, error) => { console.error(`[gateway] ${message}`, error); },
    });
    await view.start();
    const server = (0, node_http_1.createServer)((req, res) => { handleRequest(view, req, res); });
    server.on('upgrade', (req, socket, head) => { handleUpgrade(view, req, socket, head); });
    // 프록시가 먼저 끊으면 백엔드는 멀쩡한데 사용자만 튕긴다. 인게임 서버 쪽 타임아웃보다 길게 둔다.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 70_000;
    server.requestTimeout = 0;
    await new Promise((resolve) => { server.listen(PORT, HOST, resolve); });
    log(`시작. ${HOST}:${PORT} — 인게임 서버 ${view.servers.size}대 확인`);
    const shutdown = (signal) => {
        log(`${signal} 수신. 종료합니다.`);
        view.stop();
        server.close();
        void redis.quit().catch(() => undefined);
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}
/** 맵 번들 등 평범한 HTTP 요청. 헤더와 본문을 그대로 옮긴다. */
function handleRequest(view, req, res) {
    const path = req.url ?? '/';
    if (path === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, servers: view.servers.size }));
        return;
    }
    const backend = (0, routing_1.resolveBundleBackend)(path, view.servers);
    if (backend === null) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('no game server available');
        return;
    }
    const target = new URL(path, backend.address);
    const proxied = (0, node_http_1.request)({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method ?? 'GET',
        headers: req.headers,
    }, (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
    });
    proxied.on('error', (error) => {
        log(`${backend.serverId}로 넘기지 못했습니다: ${String(error)}`);
        if (!res.headersSent)
            res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad gateway');
    });
    req.pipe(proxied);
}
/**
 * WebSocket 업그레이드.
 *
 * 라이브러리로 감싸지 않고 TCP를 그대로 잇는다. 업그레이드가 끝난 뒤의 WebSocket은 프레임을
 * 해석할 이유가 없는 바이트 흐름이고, 게이트웨이가 프레임을 뜯어보기 시작하면 프로토콜 버전이
 * 하나 더 생긴다 — 인게임 서버와 클라이언트 사이의 계약에 제3자가 끼는 셈이다.
 */
function handleUpgrade(view, req, socket, head) {
    const path = req.url ?? '/';
    const backend = (0, routing_1.resolveWebSocketBackend)(path, view.servers);
    if (backend === null) {
        // 지금은 없는 서버다. 방이 옮겨 갔거나 막 사라진 것이므로 클라이언트가 매칭 서버에
        // 다시 물어보게 한다 — 그 경로가 새 주소를 알려 준다.
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        return;
    }
    const target = new URL(backend.address);
    const upstream = (0, node_net_1.connect)(Number(target.port), target.hostname, () => {
        const headers = [`GET ${path} HTTP/1.1`];
        for (const [name, value] of Object.entries(req.headers)) {
            if (value === undefined)
                continue;
            for (const single of Array.isArray(value) ? value : [value])
                headers.push(`${name}: ${single}`);
        }
        upstream.write(`${headers.join('\r\n')}\r\n\r\n`);
        if (head.length > 0)
            upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    const drop = (error) => {
        if (error !== undefined)
            log(`${backend.serverId} WebSocket 중계 실패: ${String(error)}`);
        socket.destroy();
        upstream.destroy();
    };
    upstream.on('error', drop);
    socket.on('error', drop);
    // 한쪽이 닫히면 반대쪽도 닫는다. 안 그러면 소켓이 반쯤 열린 채 쌓인다.
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
}
main().catch((error) => {
    console.error('[gateway] 기동 실패', error);
    process.exit(1);
});
//# sourceMappingURL=main.js.map