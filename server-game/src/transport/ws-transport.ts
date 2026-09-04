import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import {
    CloseCode,
    ErrorCode,
    INPUT_PACKET_BYTES,
    JSON_MESSAGE_VERSION,
    isRetryable,
    type ClientMessage,
    type ServerMessage,
    ViolationKind,
} from 'shared';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { ConnectionManager, OpenConnection } from '../gateway/connection-manager';
import type { AuthenticatedPrincipal, TicketAuthenticator } from '../gateway/ticket-auth';
import { AbuseRateLimiter, type RateSubject } from '../gateway/rate-limit';
import { RateLimitViolationAggregator } from '../gateway/rate-limit-violations';
import { parseAuthMessage, parseClientMessage, type ViolationSink } from '../gateway/message-router';
import type { Connection, GameTransport, TransportHandlers } from './game-transport';

export interface WsProtectionLimits {
    authTimeoutMs: number;
    maxBinaryFrameBytes: number;
    maxJsonFrameBytes: number;
    maxInputPacketsPerSec: number;
    maxJsonCommandsPerSec: number;
    maxIpInputPacketsPerSec: number;
    maxIpJsonCommandsPerSec: number;
    emojiCooldownMs: number;
    maxReplayRequestsPerMinute: number;
    maxConcurrentReplayDownloads: number;
    socketBufferSoftLimitBytes: number;
    socketBufferHardLimitBytes: number;
    socketBufferHardLimitGraceMs: number;
}

export interface WsServerMetadata {
    protocolVersion: number;
    rulesVersion: string;
    mapBundleHash: string;
}


/**
 * 리플레이 파일 하나를 내준다.
 *
 * 표가 맞지 않으면 404다 — 403이 아니다. 파일이 있는지 없는지를 표 없이 알아낼 수 있으면
 * 저장소 키를 훑어 무엇이 있는지 셀 수 있다.
 */
const REPLAY_TICKET = /^[A-Za-z0-9_-]{32}$/u;

function hasRequestBody(request: IncomingMessage): boolean {
    const length = request.headers['content-length'];
    return request.headers['transfer-encoding'] !== undefined
        || (length !== undefined && length !== '0');
}

async function serveReplay(
    request: IncomingMessage,
    response: ServerResponse,
    readReplay: (storageKey: string, ticket: string) => Promise<Uint8Array | null>,
    admit: () => { readonly status: 429 | 503; readonly release?: never } | { readonly status: 200; readonly release: () => void },
): Promise<void> {
    let release: (() => void) | null = null;
    try {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { Allow: 'GET, HEAD' }).end();
            return;
        }
        if (hasRequestBody(request)) {
            response.writeHead(400).end();
            return;
        }
        const url = new URL(request.url ?? '/', 'http://localhost');
        const storageKey = decodeURIComponent(url.pathname.slice('/replays/'.length));
        const tickets = url.searchParams.getAll('ticket');
        const ticket = tickets.length === 1 ? tickets[0] ?? '' : '';
        // Redis 키를 만들기 전에 발급기가 만드는 192-bit base64url 표인지 확인한다. 임의 문자열은
        // 파일 존재 여부와 똑같이 404로 감춰 중앙 저장소까지 가지 않는다.
        if (!REPLAY_TICKET.test(ticket)) {
            response.writeHead(404).end();
            return;
        }
        const admission = admit();
        if (admission.status !== 200) {
            response.writeHead(admission.status).end();
            return;
        }
        release = admission.release;
        const body = await readReplay(storageKey, ticket);
        if (!body) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': body.byteLength,
            // 브라우저가 열지 않고 저장하게 한다. 이 파일은 재생기가 읽는 것이지 화면이 아니다.
            'Content-Disposition': `attachment; filename="${storageKey.replace(/[^A-Za-z0-9_.-]/g, '_')}"`,
            'Cache-Control': 'no-store',
        });
        response.end(request.method === 'HEAD' ? undefined : Buffer.from(body));
    } catch {
        if (!response.headersSent) response.writeHead(404);
        response.end();
    } finally {
        release?.();
    }
}

export interface WsTransportOptions {
    host: string;
    port: number;
    path: string;
    allowedOrigins: readonly string[];
    trustedProxies: readonly string[];
    limits: WsProtectionLimits;
    connections: ConnectionManager;
    authenticator: TicketAuthenticator;
    metadata: WsServerMetadata;
    /** Exact validated JSON bundle, served immutably by its advertised hash. */
    mapBundleBody?: string;
    /**
     * 표를 확인하고 리플레이 파일을 읽어 준다. 없으면 `/replays/`는 404다.
     *
     * 이 서버는 계정을 모른다 — 누가 받을 자격이 있는지는 매칭 서버가 판단하고 한 번짜리 표로
     * 알려 준다. 여기서는 표가 그 파일을 가리키는지만 본다.
     */
    readReplay?: (storageKey: string, ticket: string) => Promise<Uint8Array | null>;
    getServerTick: () => number;
    violationSink: ViolationSink;
    rateLimiter?: AbuseRateLimiter;
    server?: Server;
}

type MessageBody = ServerMessage extends infer Message
    ? Message extends ServerMessage ? Omit<Message, 'v' | 'eventId' | 'serverTick'> : never
    : never;

const RATE_LIMIT_SCOPES = ['connection', 'user'] as const;
const ABUSIVE_RATE_MULTIPLIER = 5;
const ABUSIVE_RATE_WINDOWS = 5;
const RATE_LIMIT_LOG_INTERVAL_MS = 5_000;

function normalizeIp(ip: string | undefined): string {
    if (ip === undefined || ip === '') return 'unknown';
    const unbracketed = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
    return unbracketed.startsWith('::ffff:') ? unbracketed.slice(7) : unbracketed;
}

function ipv4Number(ip: string): number | null {
    if (isIP(ip) !== 4) return null;
    return ip.split('.').reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
}

function addressMatches(address: string, rule: string): boolean {
    const normalizedRule = normalizeIp(rule);
    if (!normalizedRule.includes('/')) return address === normalizedRule;
    const [networkText, prefixText] = normalizedRule.split('/');
    if (networkText === undefined || prefixText === undefined) return false;
    const addressNumber = ipv4Number(address);
    const networkNumber = ipv4Number(networkText);
    const prefix = Number(prefixText);
    if (addressNumber === null || networkNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (addressNumber & mask) === (networkNumber & mask);
}

/**
 * 이 요청을 실제로 보낸 사람의 주소.
 *
 * 전달 사슬은 **오른쪽부터** 읽는다. 각 홉이 자기가 본 주소를 뒤에 잇기 때문에, 오른쪽 끝에서
 * 신뢰하는 홉을 걷어내다 처음 만나는 낯선 주소가 우리가 아는 한 가장 앞쪽의 진짜 발신자다.
 *
 * 왼쪽 끝을 쓰면 안 된다. 그 자리는 **클라이언트가 직접 적은 값**이고, 프록시는 그 뒤에 이어
 * 붙일 뿐 지우지 않는다. 예전에는 그 값을 그대로 썼기 때문에 헤더 한 줄로 IP당 연결 제한을
 * 피할 수 있었다.
 *
 * 그래서 이 목록에는 우리 앞에 실제로 있는 홉(게이트웨이, 그 앞의 리버스 프록시)을 전부
 * 적어야 한다. 하나라도 빠지면 그 홉의 주소가 모든 사용자의 주소로 보인다.
 */
export function resolveClientIp(request: IncomingMessage, trustedProxies: readonly string[]): string {
    const peer = normalizeIp(request.socket.remoteAddress);
    const trusted = (address: string): boolean => trustedProxies.some((rule) => addressMatches(address, rule));
    if (!trusted(peer)) return peer;

    const forwarded = request.headers['x-forwarded-for'];
    const chain = (Array.isArray(forwarded) ? forwarded : [forwarded ?? ''])
        .flatMap((value) => value.split(','))
        .map((value) => normalizeIp(value.trim()))
        .filter((value) => isIP(value) !== 0);

    for (let index = chain.length - 1; index >= 0; index -= 1) {
        const address = chain[index] as string;
        if (!trusted(address)) return address;
    }
    // 사슬이 비었거나 전부 우리 홉이다. 그러면 우리가 직접 본 주소가 최선이다.
    return peer;
}

function canonicalOrigin(value: string): string | null {
    try {
        return new URL(value).origin;
    } catch {
        return null;
    }
}

function rawBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data as ArrayBuffer);
}

class WsConnection implements Connection {
    readonly id: number;
    readonly userId: number | string;
    readonly nickname: string;
    readonly isGuest: boolean;
    readonly lobbyStats: AuthenticatedPrincipal['lobbyStats'];
    readonly roomId: string;
    readonly resume: boolean;
    readonly playerId: number;
    readonly #socket: WebSocket;
    readonly #limits: WsProtectionLimits;
    readonly #getServerTick: () => number;
    #eventId = 0;
    #hardLimitTimer: NodeJS.Timeout | null = null;

    public constructor(open: OpenConnection, principal: AuthenticatedPrincipal, socket: WebSocket, limits: WsProtectionLimits, getServerTick: () => number) {
        this.id = open.id;
        this.userId = principal.userId;
        this.nickname = principal.nickname;
        this.isGuest = principal.isGuest;
        this.lobbyStats = principal.lobbyStats;
        this.roomId = principal.roomId;
        this.resume = principal.resume;
        this.playerId = principal.playerId;
        this.#socket = socket;
        this.#limits = limits;
        this.#getServerTick = getServerTick;
    }

    public sendJson(message: MessageBody): void {
        if (this.#socket.readyState !== WebSocket.OPEN) return;
        this.#watchHardLimit();
        this.#socket.send(JSON.stringify({
            v: JSON_MESSAGE_VERSION,
            eventId: this.#eventId++,
            serverTick: this.#getServerTick(),
            ...message,
        }));
    }

    public sendBinary(payload: ArrayBuffer): void {
        if (this.#socket.readyState !== WebSocket.OPEN) return;
        this.#watchHardLimit();
        if (this.#socket.bufferedAmount >= this.#limits.socketBufferSoftLimitBytes) return;
        this.#socket.send(payload, { binary: true });
    }

    public bufferedBytes(): number {
        return this.#socket.bufferedAmount;
    }

    public close(code: number, reason: string): void {
        if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
            this.#socket.close(code, reason.slice(0, 123));
        }
    }

    public clearTimers(): void {
        if (this.#hardLimitTimer !== null) clearTimeout(this.#hardLimitTimer);
        this.#hardLimitTimer = null;
    }

    #watchHardLimit(): void {
        if (this.#socket.bufferedAmount < this.#limits.socketBufferHardLimitBytes) {
            if (this.#hardLimitTimer !== null) clearTimeout(this.#hardLimitTimer);
            this.#hardLimitTimer = null;
            return;
        }
        if (this.#hardLimitTimer !== null) return;
        this.#hardLimitTimer = setTimeout(() => {
            this.#hardLimitTimer = null;
            if (this.#socket.bufferedAmount >= this.#limits.socketBufferHardLimitBytes) {
                this.close(CloseCode.PolicyViolation, 'backpressure');
            }
        }, this.#limits.socketBufferHardLimitGraceMs);
        this.#hardLimitTimer.unref();
    }
}

export class WsTransport implements GameTransport {
    readonly #options: WsTransportOptions;
    readonly #server: Server;
    readonly #webSockets: WebSocketServer;
    readonly #allowedOrigins: ReadonlySet<string>;
    readonly #rateLimiter: AbuseRateLimiter;
    readonly #rateLimitViolations: RateLimitViolationAggregator;
    readonly #rateLimitLogTimer: NodeJS.Timeout;
    readonly #sockets = new Set<WebSocket>();
    #activeReplayDownloads = 0;
    #handlers: TransportHandlers | null = null;
    #accepting = true;

    public constructor(options: WsTransportOptions) {
        this.#options = options;
        this.#server = options.server ?? createServer((request, response) => {
            const bundlePath = `/map-bundles/${options.metadata.mapBundleHash}.json`;
            if ((request.method === 'GET' || request.method === 'HEAD') && request.url === bundlePath && options.mapBundleBody && !hasRequestBody(request)) {
                const requestOrigin = typeof request.headers.origin === 'string' ? canonicalOrigin(request.headers.origin) : null;
                const corsOrigin = requestOrigin && options.allowedOrigins.some((origin) => canonicalOrigin(origin) === requestOrigin)
                    ? requestOrigin
                    : null;
                response.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'public, max-age=31536000, immutable',
                    'Content-Length': Buffer.byteLength(options.mapBundleBody),
                    ETag: `"${options.metadata.mapBundleHash}"`,
                    ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin, Vary: 'Origin' } : {}),
                }).end(request.method === 'HEAD' ? undefined : options.mapBundleBody);
                return;
            }
            if (request.url?.startsWith('/replays/') && options.readReplay) {
                void serveReplay(request, response, options.readReplay, () => this.#admitReplay(request));
                return;
            }
            response.writeHead(404).end();
        });
        this.#webSockets = new WebSocketServer({ noServer: true, maxPayload: Math.max(options.limits.maxJsonFrameBytes, options.limits.maxBinaryFrameBytes) });
        this.#allowedOrigins = new Set(options.allowedOrigins.map(canonicalOrigin).filter((origin): origin is string => origin !== null));
        this.#rateLimiter = options.rateLimiter ?? new AbuseRateLimiter();
        this.#rateLimitViolations = new RateLimitViolationAggregator(options.violationSink);
        this.#rateLimitLogTimer = setInterval(() => this.#rateLimitViolations.flushReady(RATE_LIMIT_LOG_INTERVAL_MS), RATE_LIMIT_LOG_INTERVAL_MS);
        this.#rateLimitLogTimer.unref();
    }

    public async listen(handlers: TransportHandlers): Promise<void> {
        if (this.#handlers !== null) throw new Error('transport is already listening');
        this.#handlers = handlers;
        this.#server.on('upgrade', this.#onUpgrade);
        if (this.#server.listening) return;
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => reject(error);
            this.#server.once('error', onError);
            this.#server.listen(this.#options.port, this.#options.host, () => {
                this.#server.off('error', onError);
                resolve();
            });
        });
    }

    public setAccepting(accepting: boolean): void {
        this.#accepting = accepting;
    }

    public connectionCount(): number {
        return this.#options.connections.count();
    }

    public boundPort(): number {
        const address = this.#server.address();
        if (address === null || typeof address === 'string') throw new Error('transport is not listening on a TCP port');
        return address.port;
    }

    public async close(): Promise<void> {
        this.#accepting = false;
        clearInterval(this.#rateLimitLogTimer);
        this.#server.off('upgrade', this.#onUpgrade);
        for (const socket of this.#sockets) socket.close(CloseCode.Normal, 'server shutdown');
        await new Promise<void>((resolve, reject) => {
            this.#webSockets.close(() => {
                this.#server.close((error) => {
                    this.#rateLimitViolations.flushAll();
                    return error === undefined ? resolve() : reject(error);
                });
            });
        });
    }

    readonly #onUpgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void => {
        try {
            let pathname: string;
            try {
                const url = new URL(request.url ?? '', 'http://game.invalid');
                pathname = url.pathname;
                if (url.search !== '') return this.#rejectUpgrade(socket, 400, 'Bad Request');
            } catch {
                return this.#rejectUpgrade(socket, 400, 'Bad Request');
            }
            const originHeader = request.headers.origin;
            const origin = typeof originHeader === 'string' ? canonicalOrigin(originHeader) : null;
            if (pathname !== this.#options.path || origin === null || !this.#allowedOrigins.has(origin)) {
                return this.#rejectUpgrade(socket, 403, 'Forbidden');
            }
            if (!this.#accepting) {
                return this.#rejectUpgrade(socket, 503, 'Service Unavailable');
            }
            const ip = resolveClientIp(request, this.#options.trustedProxies);
            if (!this.#options.connections.canOpen(ip)) return this.#rejectUpgrade(socket, 429, 'Too Many Requests');
            this.#webSockets.handleUpgrade(request, socket, head, (webSocket) => this.#acceptSocket(webSocket, ip));
        } catch (error: unknown) {
            // upgrade도 공개 입력 경로다. ws 라이브러리나 연결 장부가 던져도 이 TCP 연결만 버린다.
            const ip = resolveClientIp(request, this.#options.trustedProxies);
            try {
                this.#options.violationSink({
                    kind: ViolationKind.BadState,
                    userId: `ip:${ip}`,
                    roomId: null,
                    tick: null,
                    severity: 'high',
                    ruleVersion: 1,
                    detail: { kind: 'internal-exception', phase: 'upgrade', error: error instanceof Error ? error.name : typeof error },
                });
            } catch (signalError: unknown) {
                console.error('[swITch] WebSocket violation sink failed', signalError);
            }
            socket.destroy();
        }
    };

    #acceptSocket(socket: WebSocket, ip: string): void {
        const open = this.#options.connections.open(ip);
        if (open === null) return socket.close(CloseCode.PolicyViolation, 'connection limit');
        this.#sockets.add(socket);
        let authenticated: WsConnection | null = null;
        let authenticating = false;
        let authRequestId: number | null = null;
        const timeout = setTimeout(() => {
            if (authenticated === null) this.#sendErrorAndClose(socket, authRequestId, ErrorCode.AuthTimeout, CloseCode.PolicyViolation);
        }, this.#options.limits.authTimeoutMs);
        timeout.unref();

        socket.on('message', (data, isBinary) => {
            void (async () => {
                const buffer = rawBuffer(data);
                if (authenticated === null) {
                    if (authenticating || isBinary || buffer.byteLength > this.#options.limits.maxJsonFrameBytes) {
                        this.#signal(open, null, ViolationKind.BadState, 'medium');
                        this.#sendErrorAndClose(socket, null, ErrorCode.AuthFailed, isBinary ? CloseCode.PolicyViolation : CloseCode.MessageTooBig);
                        return;
                    }
                    const auth = parseAuthMessage(buffer.toString('utf8'));
                    authRequestId = auth?.requestId ?? null;
                    if (auth === null) {
                        this.#signal(open, null, ViolationKind.BadState, 'medium');
                        this.#sendErrorAndClose(socket, authRequestId, ErrorCode.AuthFailed, CloseCode.PolicyViolation);
                        return;
                    }
                    authenticating = true;
                    const principal = await this.#options.authenticator.authenticate(open.id, auth.ticket);
                    if (principal === null || socket.readyState !== WebSocket.OPEN) {
                        this.#sendErrorAndClose(socket, authRequestId, ErrorCode.AuthFailed, CloseCode.PolicyViolation);
                        return;
                    }
                    clearTimeout(timeout);
                    authenticated = new WsConnection(open, principal, socket, this.#options.limits, this.#options.getServerTick);
                    this.#handlers?.onConnect(authenticated);
                    authenticated.sendJson({
                        type: 'auth.ok',
                        payload: {
                            playerId: principal.playerId,
                            roomId: principal.roomId,
                            roomState: principal.roomState,
                            role: principal.role,
                            guest: principal.isGuest,
                            ...this.#options.metadata,
                        },
                    });
                    return;
                }
                if (isBinary) this.#handleBinary(authenticated, open, buffer);
                else this.#handleJson(authenticated, open, buffer);
            })().catch((error: unknown) => {
                // EventEmitter는 반환된 Promise를 기다리지 않는다. 여기서 끝을 막지 않으면 인증이나
                // 방 handler의 논리 오류 하나가 unhandled rejection이 되어 다른 모든 방까지 죽인다.
                this.#handleConnectionException(socket, open, authenticated, 'message', error);
            });
        });
        socket.on('close', (_code, reason) => {
            try {
                clearTimeout(timeout);
                authenticated?.clearTimers();
                this.#sockets.delete(socket);
                this.#options.connections.close(open.id);
                this.#rateLimitViolations.flushConnection(open.id);
            } catch (error: unknown) {
                this.#handleConnectionException(socket, open, authenticated, 'disconnect', error, false);
            }
            if (authenticated !== null) {
                try {
                    this.#handlers?.onDisconnect(authenticated, reason.toString('utf8'));
                } catch (error: unknown) {
                    // close callback의 예외는 Promise도 아니어서 곧바로 프로세스까지 올라간다.
                    // 연결 장부는 이미 정리한 뒤이며, 오류는 이 연결의 구조화된 신호로만 남긴다.
                    this.#handleConnectionException(socket, open, authenticated, 'disconnect', error, false);
                }
            }
        });
        socket.on('error', () => { /* close performs the single cleanup path */ });
    }

    #handleBinary(connection: WsConnection, open: OpenConnection, buffer: Buffer): void {
        if (buffer.byteLength > this.#options.limits.maxBinaryFrameBytes) {
            this.#signal(open, connection, ViolationKind.FrameTooBig, 'high', { bytes: buffer.byteLength });
            this.#sendErrorAndCloseSocket(connection, ErrorCode.InvalidPayload, CloseCode.MessageTooBig);
            return;
        }
        if (buffer.byteLength !== INPUT_PACKET_BYTES) {
            this.#signal(open, connection, ViolationKind.BadLength, 'medium', { bytes: buffer.byteLength });
            return;
        }
        const decision = this.#rateLimiter.check('input', this.#subject(open, connection), this.#options.limits.maxInputPacketsPerSec, 1_000, {
            scopes: RATE_LIMIT_SCOPES,
            abusiveMultiplier: ABUSIVE_RATE_MULTIPLIER,
            abusiveWindows: ABUSIVE_RATE_WINDOWS,
        });
        const ipDecision = this.#rateLimiter.check('input-ip', this.#subject(open, connection), this.#options.limits.maxIpInputPacketsPerSec, 1_000, {
            scopes: ['ip'],
            abusiveMultiplier: ABUSIVE_RATE_MULTIPLIER,
            abusiveWindows: ABUSIVE_RATE_WINDOWS,
        });
        if (!decision.allowed || !ipDecision.allowed) {
            const combined = { abusive: decision.abusive || ipDecision.abusive };
            this.#signalRateLimit(open, connection, 'input', combined.abusive ? 'high' : 'medium');
            // A browser can legitimately burst after timer throttling. Only close a connection that
            // sustains >5x the limit for five whole windows; ordinary excess input is safely dropped
            // because the room keeps that player's latest accepted input state.
            if (combined.abusive) this.#sendErrorAndCloseSocket(connection, ErrorCode.RateLimited, CloseCode.PolicyViolation);
            return;
        }
        const frame = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
        this.#handlers?.onInput(connection, frame);
    }

    #handleJson(connection: WsConnection, open: OpenConnection, buffer: Buffer): void {
        if (buffer.byteLength > this.#options.limits.maxJsonFrameBytes) {
            this.#signal(open, connection, ViolationKind.FrameTooBig, 'high', { bytes: buffer.byteLength });
            this.#sendErrorAndCloseSocket(connection, ErrorCode.InvalidPayload, CloseCode.MessageTooBig);
            return;
        }
        const text = buffer.toString('utf8');
        const parsed = parseClientMessage(text, { userId: connection.userId, roomId: connection.roomId, tick: this.#options.getServerTick() }, this.#options.violationSink);
        const decision = this.#rateLimiter.check('json', this.#subject(open, connection), this.#options.limits.maxJsonCommandsPerSec, 1_000, {
            scopes: RATE_LIMIT_SCOPES,
            abusiveMultiplier: ABUSIVE_RATE_MULTIPLIER,
            abusiveWindows: ABUSIVE_RATE_WINDOWS,
        });
        const ipDecision = this.#rateLimiter.check('json-ip', this.#subject(open, connection), this.#options.limits.maxIpJsonCommandsPerSec, 1_000, {
            scopes: ['ip'],
            abusiveMultiplier: ABUSIVE_RATE_MULTIPLIER,
            abusiveWindows: ABUSIVE_RATE_WINDOWS,
        });
        if (!decision.allowed || !ipDecision.allowed) {
            const abusive = decision.abusive || ipDecision.abusive;
            connection.sendJson({ type: 'error', payload: { requestId: parsed.requestId, code: ErrorCode.RateLimited, retryable: isRetryable(ErrorCode.RateLimited) } });
            this.#signalRateLimit(open, connection, 'json', abusive ? 'high' : 'medium');
            // JSON commands use the same deliberate-abuse threshold as input. This keeps command
            // floods bounded without disconnecting a client for a short UI/timer burst.
            if (abusive) connection.close(CloseCode.PolicyViolation, 'rate limit');
            return;
        }
        if (parsed.message === null) {
            connection.sendJson({ type: 'error', payload: { requestId: parsed.requestId, code: ErrorCode.InvalidPayload, retryable: isRetryable(ErrorCode.InvalidPayload) } });
            return;
        }
        if (parsed.message.type === 'game.emoji') {
            const emoji = this.#rateLimiter.cooldown('emoji', this.#subject(open, connection), this.#options.limits.emojiCooldownMs, ['user']);
            if (!emoji.allowed) {
                connection.sendJson({ type: 'error', payload: { requestId: parsed.requestId, code: ErrorCode.RateLimited, retryable: true } });
                return;
            }
        }
        this.#handlers?.onJson(connection, parsed.message as ClientMessage);
    }

    #subject(open: OpenConnection, connection: WsConnection): RateSubject {
        return { connectionId: open.id, ip: open.ip, userId: connection.userId };
    }

    #admitReplay(request: IncomingMessage): { readonly status: 429 | 503; readonly release?: never } | { readonly status: 200; readonly release: () => void } {
        const ip = resolveClientIp(request, this.#options.trustedProxies);
        const decision = this.#rateLimiter.check(
            'replay-http',
            { connectionId: 0, ip },
            this.#options.limits.maxReplayRequestsPerMinute,
            60_000,
            { scopes: ['ip'] },
        );
        if (!decision.allowed) return { status: 429 };
        if (this.#activeReplayDownloads >= this.#options.limits.maxConcurrentReplayDownloads) return { status: 503 };
        this.#activeReplayDownloads += 1;
        let released = false;
        return {
            status: 200,
            release: () => {
                if (released) return;
                released = true;
                this.#activeReplayDownloads -= 1;
            },
        };
    }

    #handleConnectionException(
        socket: WebSocket,
        open: OpenConnection,
        connection: WsConnection | null,
        phase: 'message' | 'disconnect',
        error: unknown,
        close = true,
    ): void {
        try {
            this.#signal(open, connection, ViolationKind.BadState, 'high', {
                kind: 'internal-exception',
                phase,
                error: error instanceof Error ? error.name : typeof error,
            });
        } catch (signalError: unknown) {
            // 진단 소비자의 장애가 원래 예외 경계를 다시 뚫으면 안 된다.
            console.error('[swITch] WebSocket violation sink failed', signalError);
        }
        if (!close) return;
        try {
            this.#sendErrorAndClose(socket, null, ErrorCode.Internal, CloseCode.PolicyViolation);
        } catch {
            // 정상 close조차 실패한 소켓은 이 연결만 강제로 버린다.
            try { socket.terminate(); } catch { /* 이미 망가진 연결은 close 정리 경로가 회수한다. */ }
        }
    }

    #signal(open: OpenConnection, connection: WsConnection | null, kind: typeof ViolationKind[keyof typeof ViolationKind], severity: 'low' | 'medium' | 'high', detail?: Record<string, number | string>): void {
        this.#options.violationSink({
            kind,
            userId: connection?.userId ?? `ip:${open.ip}`,
            roomId: connection?.roomId ?? null,
            tick: connection === null ? null : this.#options.getServerTick(),
            severity,
            ruleVersion: 1,
            ...(detail === undefined ? {} : { detail }),
        });
    }

    #signalRateLimit(open: OpenConnection, connection: WsConnection, rule: 'input' | 'json', severity: 'medium' | 'high'): void {
        this.#rateLimitViolations.record(open.id, open.ip, rule, {
            kind: ViolationKind.RateLimit,
            userId: connection.userId,
            roomId: connection.roomId,
            tick: this.#options.getServerTick(),
            severity,
            ruleVersion: 1,
        });
    }

    #sendErrorAndCloseSocket(connection: WsConnection, code: typeof ErrorCode[keyof typeof ErrorCode], closeCode: number): void {
        connection.sendJson({ type: 'error', payload: { requestId: null, code, retryable: isRetryable(code) } });
        connection.close(closeCode, 'policy');
    }

    #sendErrorAndClose(socket: WebSocket, requestId: number | null, code: typeof ErrorCode[keyof typeof ErrorCode], closeCode: number): void {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ v: JSON_MESSAGE_VERSION, type: 'error', eventId: 0, serverTick: this.#options.getServerTick(), payload: { requestId, code, retryable: isRetryable(code) } }));
            socket.close(closeCode, 'policy');
        }
    }

    #rejectUpgrade(socket: import('node:stream').Duplex, status: number, reason: string): void {
        socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
}
