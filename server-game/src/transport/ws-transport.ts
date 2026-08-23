import { createServer, type IncomingMessage, type Server } from 'node:http';
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
import { parseAuthMessage, parseClientMessage, type ViolationSink } from '../gateway/message-router';
import type { Connection, GameTransport, TransportHandlers } from './game-transport';

export interface WsProtectionLimits {
    authTimeoutMs: number;
    maxBinaryFrameBytes: number;
    maxJsonFrameBytes: number;
    maxInputPacketsPerSec: number;
    maxJsonCommandsPerSec: number;
    emojiCooldownMs: number;
    socketBufferSoftLimitBytes: number;
    socketBufferHardLimitBytes: number;
    socketBufferHardLimitGraceMs: number;
}

export interface WsServerMetadata {
    protocolVersion: number;
    rulesVersion: string;
    mapBundleHash: string;
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
    getServerTick: () => number;
    violationSink: ViolationSink;
    rateLimiter?: AbuseRateLimiter;
    server?: Server;
}

type MessageBody = ServerMessage extends infer Message
    ? Message extends ServerMessage ? Omit<Message, 'v' | 'eventId' | 'serverTick'> : never
    : never;

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

export function resolveClientIp(request: IncomingMessage, trustedProxies: readonly string[]): string {
    const peer = normalizeIp(request.socket.remoteAddress);
    if (!trustedProxies.some((rule) => addressMatches(peer, rule))) return peer;
    const forwarded = request.headers['x-forwarded-for'];
    const candidate = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    const normalized = normalizeIp(candidate?.trim());
    return isIP(normalized) === 0 ? peer : normalized;
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
    readonly #sockets = new Set<WebSocket>();
    #handlers: TransportHandlers | null = null;
    #accepting = true;

    public constructor(options: WsTransportOptions) {
        this.#options = options;
        this.#server = options.server ?? createServer((_request, response) => {
            response.writeHead(404).end();
        });
        this.#webSockets = new WebSocketServer({ noServer: true, maxPayload: Math.max(options.limits.maxJsonFrameBytes, options.limits.maxBinaryFrameBytes) });
        this.#allowedOrigins = new Set(options.allowedOrigins.map(canonicalOrigin).filter((origin): origin is string => origin !== null));
        this.#rateLimiter = options.rateLimiter ?? new AbuseRateLimiter();
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
        this.#server.off('upgrade', this.#onUpgrade);
        for (const socket of this.#sockets) socket.close(CloseCode.Normal, 'server shutdown');
        await new Promise<void>((resolve, reject) => {
            this.#webSockets.close(() => {
                this.#server.close((error) => error === undefined ? resolve() : reject(error));
            });
        });
    }

    readonly #onUpgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void => {
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
                    try {
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
                    } catch {
                        this.#sendErrorAndClose(socket, null, ErrorCode.Internal, CloseCode.PolicyViolation);
                    }
                    return;
                }
                if (isBinary) this.#handleBinary(authenticated, open, buffer);
                else this.#handleJson(authenticated, open, buffer);
            })();
        });
        socket.on('close', (_code, reason) => {
            clearTimeout(timeout);
            authenticated?.clearTimers();
            this.#sockets.delete(socket);
            this.#options.connections.close(open.id);
            this.#rateLimiter.releaseConnection(open.id);
            if (authenticated !== null) this.#handlers?.onDisconnect(authenticated, reason.toString('utf8'));
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
        const decision = this.#rateLimiter.check('input', this.#subject(open, connection), this.#options.limits.maxInputPacketsPerSec, 1_000);
        if (!decision.allowed) {
            this.#signal(open, connection, ViolationKind.RateLimit, decision.persistent ? 'high' : 'medium');
            if (decision.persistent) this.#sendErrorAndCloseSocket(connection, ErrorCode.RateLimited, CloseCode.PolicyViolation);
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
        const decision = this.#rateLimiter.check('json', this.#subject(open, connection), this.#options.limits.maxJsonCommandsPerSec, 1_000);
        if (!decision.allowed) {
            connection.sendJson({ type: 'error', payload: { requestId: parsed.requestId, code: ErrorCode.RateLimited, retryable: isRetryable(ErrorCode.RateLimited) } });
            this.#signal(open, connection, ViolationKind.RateLimit, decision.persistent ? 'high' : 'medium');
            if (decision.persistent) connection.close(CloseCode.PolicyViolation, 'rate limit');
            return;
        }
        if (parsed.message === null) {
            connection.sendJson({ type: 'error', payload: { requestId: parsed.requestId, code: ErrorCode.InvalidPayload, retryable: isRetryable(ErrorCode.InvalidPayload) } });
            return;
        }
        if (parsed.message.type === 'game.emoji') {
            const emoji = this.#rateLimiter.cooldown('emoji', this.#subject(open, connection), this.#options.limits.emojiCooldownMs);
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
