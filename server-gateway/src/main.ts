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

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import Redis from 'ioredis';
import { makeKeys } from 'shared';
import { IpRateLimiter } from './ip-rate-limit';
import { RegistryView } from './registry-view';
import {
    filterHttpRequestHeaders,
    filterHttpResponseHeaders,
    filterWebSocketRequestHeaders,
    isPublicDownloadMethod,
    parseBackendAddress,
    requestHasBody,
    resolveBundleRoute,
    resolveWebSocketRoute,
    type Backend,
} from './routing';

const log = (message: string): void => { console.log(`[gateway] ${message}`); };

const env = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;
const PORT = Number(env('GATEWAY_PORT', '4100'));
const HOST = env('GATEWAY_HOST', '0.0.0.0');
const APP_ENV = env('APP_ENV', 'dev');
const UPSTREAM_CONNECT_TIMEOUT_MS = Number(env('GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS', '3000'));
const UPSTREAM_RESPONSE_TIMEOUT_MS = Number(env('GATEWAY_UPSTREAM_RESPONSE_TIMEOUT_MS', '10000'));
const REPLAY_REQUESTS_PER_MINUTE = Number(env('GATEWAY_REPLAY_REQUESTS_PER_MINUTE', '30'));

export interface GatewayProxyLimits {
    readonly connectTimeoutMs: number;
    readonly responseTimeoutMs: number;
    readonly replayRequestsPerMinute: number;
}

const DEFAULT_PROXY_LIMITS: GatewayProxyLimits = {
    connectTimeoutMs: UPSTREAM_CONNECT_TIMEOUT_MS,
    responseTimeoutMs: UPSTREAM_RESPONSE_TIMEOUT_MS,
    replayRequestsPerMinute: REPLAY_REQUESTS_PER_MINUTE,
};

type RegistrySource = Pick<RegistryView, 'servers'>;

function portRanges(value: string): Array<{ min: number; max: number }> {
    return value.split(',').map((part) => {
        const [first, second] = part.trim().split('-', 2);
        const min = Number(first);
        const max = Number(second ?? first);
        if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 65_535 || min > max) {
            throw new Error(`올바르지 않은 backend port allowlist: ${part}`);
        }
        return { min, max };
    });
}

async function main(): Promise<void> {
    const redis = new Redis({
        host: env('REDIS_HOST', 'localhost'),
        port: Number(env('REDIS_PORT', '6379')),
        ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
        lazyConnect: true,
        maxRetriesPerRequest: 2,
    });
    await redis.connect();

    const view = new RegistryView({
        redis,
        keys: makeKeys(APP_ENV),
        logger: (message, error) => { console.error(`[gateway] ${message}`, error); },
        addressPolicy: {
            // 목적지는 heartbeat가 고르지만 갈 수 있는 네트워크 범위는 운영자가 고정한다.
            // 기본값은 한 호스트 배포이고, 컨테이너/DNS 배포는 명시적으로 이름을 더한다.
            allowedHosts: env('GATEWAY_ALLOWED_GAME_HOSTS', '127.0.0.1,localhost,::1').split(',').map((host) => host.trim()).filter(Boolean),
            // GAME_PORT=0 배포는 OS의 ephemeral port를 쓰므로 기본 범위는 비특권 포트 전체다.
            // 더 좁힐 수 있는 배포에서는 환경값으로 실제 서비스 범위만 남긴다.
            allowedPortRanges: portRanges(env('GATEWAY_ALLOWED_GAME_PORTS', '1024-65535')),
        },
    });
    await view.start();

    const replayLimiter = new IpRateLimiter();
    const server = createServer((req, res) => {
        try {
            handleRequest(view, replayLimiter, req, res);
        } catch (error: unknown) {
            log(`HTTP 요청 경계에서 오류를 막았습니다: ${String(error)}`);
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('bad gateway');
        }
    });
    server.on('upgrade', (req, socket, head) => {
        try {
            handleUpgrade(view, req, socket as Socket, head);
        } catch (error: unknown) {
            log(`WebSocket upgrade 경계에서 오류를 막았습니다: ${String(error)}`);
            socket.destroy();
        }
    });

    // 프록시가 먼저 끊으면 백엔드는 멀쩡한데 사용자만 튕긴다. 인게임 서버 쪽 타임아웃보다 길게 둔다.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 70_000;
    // 공개 프록시에서는 끝나지 않는 요청 본문이 연결을 무기한 차지하지 못하게 상한이 필요하다.
    server.requestTimeout = 30_000;

    await new Promise<void>((resolve) => { server.listen(PORT, HOST, resolve); });
    log(`시작. ${HOST}:${PORT} — 인게임 서버 ${view.servers.size}대 확인`);

    const shutdown = (signal: string): void => {
        log(`${signal} 수신. 종료합니다.`);
        view.stop();
        server.close();
        void redis.quit().catch(() => undefined);
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** 맵 번들 등 평범한 HTTP 요청. */
export function handleRequest(
    view: RegistrySource,
    replayLimiter: IpRateLimiter,
    req: IncomingMessage,
    res: ServerResponse,
    limits: GatewayProxyLimits = DEFAULT_PROXY_LIMITS,
): void {
    const path = req.url ?? '/';
    if (path === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, servers: view.servers.size }));
        return;
    }

    const resolution = resolveBundleRoute(path, view.servers);
    if (resolution.kind === 'not-found') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
    }
    if (resolution.kind === 'unavailable') {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('no game server available');
        return;
    }

    const { backend, path: targetPath } = resolution.route;
    if (!isPublicDownloadMethod(req.method)) {
        res.writeHead(405, { Allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
    }
    if (requestHasBody(req.headers)) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('request body not allowed');
        return;
    }
    if (targetPath.startsWith('/replays/')) {
        // forwarded 헤더는 여기서 신뢰하지 않는다. 신뢰 프록시 판정 없이 쓰면 공격자가 매 요청마다
        // IP를 바꿔 limiter를 피한다. 직접 본 홉 단위 제한은 보수적이지만 위조할 수 없다.
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (!replayLimiter.allow(ip, limits.replayRequestsPerMinute, 60_000)) {
            res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('too many requests');
            return;
        }
    }
    const target = parseBackendAddress(backend.address);
    if (target === null) {
        log(`올바르지 않은 backend 주소를 제외했습니다: serverId=${backend.serverId}`);
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad gateway');
        return;
    }
    const proxied = httpRequest(
        {
            hostname: target.hostname,
            port: target.port,
            path: targetPath,
            method: req.method ?? 'GET',
            headers: filterHttpRequestHeaders(req.headers, req.socket.remoteAddress),
        },
        (upstream) => {
            clearTimeout(responseTimer);
            // 헤더 뒤에 본문이 멎는 경우도 소켓을 영원히 점유하지 못하게 한다.
            upstream.setTimeout(limits.responseTimeoutMs, () => upstream.destroy(new Error('upstream response timeout')));
            res.writeHead(upstream.statusCode ?? 502, filterHttpResponseHeaders(upstream.headers));
            upstream.pipe(res);
        },
    );
    const responseTimer = setTimeout(() => proxied.destroy(new Error('upstream response timeout')), limits.responseTimeoutMs);
    responseTimer.unref();
    proxied.on('socket', (upstreamSocket) => {
        if (!upstreamSocket.connecting) return;
        const connectTimer = setTimeout(() => proxied.destroy(new Error('upstream connect timeout')), limits.connectTimeoutMs);
        connectTimer.unref();
        upstreamSocket.once('connect', () => clearTimeout(connectTimer));
        upstreamSocket.once('error', () => clearTimeout(connectTimer));
    });
    proxied.on('error', (error: unknown) => {
        clearTimeout(responseTimer);
        log(`${backend.serverId}로 넘기지 못했습니다: ${String(error)}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
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
function handleUpgrade(view: RegistrySource, req: IncomingMessage, socket: Socket, head: Buffer): void {
    const path = req.url ?? '/';
    const resolution = resolveWebSocketRoute(path, view.servers);
    if (resolution.kind === 'not-found') {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
    }
    if (resolution.kind === 'unavailable') {
        // 지금은 없는 서버다. 방이 옮겨 갔거나 막 사라진 것이므로 클라이언트가 매칭 서버에
        // 다시 물어보게 한다 — 그 경로가 새 주소를 알려 준다.
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        return;
    }

    const { backend, path: targetPath } = resolution.route;
    const target = parseBackendAddress(backend.address);
    if (target === null) {
        log(`올바르지 않은 WebSocket backend 주소를 제외했습니다: serverId=${backend.serverId}`);
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        return;
    }
    const upstream = connect(target.port, target.hostname, () => {
        upstream.setTimeout(0);
        const headers = [`GET ${targetPath} HTTP/1.1`];
        for (const [name, value] of Object.entries(
            filterWebSocketRequestHeaders(req.headers, req.socket.remoteAddress),
        )) {
            for (const single of Array.isArray(value) ? value : [value]) headers.push(`${name}: ${single}`);
        }
        upstream.write(`${headers.join('\r\n')}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('upstream connect timeout')));

    const drop = (error: unknown): void => {
        if (error !== undefined) log(`${backend.serverId} WebSocket 중계 실패: ${String(error)}`);
        socket.destroy();
        upstream.destroy();
    };
    upstream.on('error', drop);
    socket.on('error', drop);
    // 한쪽이 닫히면 반대쪽도 닫는다. 안 그러면 소켓이 반쯤 열린 채 쌓인다.
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
}

export type { Backend };

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error('[gateway] 기동 실패', error);
        process.exit(1);
    });
}
