'use strict';
// Disposable local bots. Guest credentials remain in memory or the isolated Redis
// pool, never stdout, files, browser traces, or test assertion text.
const Redis = require('ioredis');
const WebSocket = require('ws');
const { makeKeys, encodeInput, decodeSnapshot } = require('shared');
const { existsSync } = require('node:fs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function assertAuditEnv() {
    if (process.platform !== 'linux' || !existsSync('/.dockerenv')
        || process.env.AUDIT_STACK !== 'true' || process.env.APP_ENV !== 'audit'
        || process.env.E2E_BASE_URL !== 'http://web' || process.env.REDIS_HOST !== 'redis'
        || process.env.DB_HOST !== 'postgres' || !/^audit_[a-z0-9_]+$/.test(process.env.DB_NAME || '')) {
        throw new Error('Bots require the disposable internal Docker audit stack');
    }
}
function bounded(value, min, max, name) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}; range ${min}..${max}`);
    return value;
}
class AuditBots {
    constructor(options = {}) {
        assertAuditEnv();
        this.seed = bounded(options.seed ?? 42, 1, 0x7fffffff, 'seed');
        this.durationMs = bounded(options.durationMs ?? 300_000, 10_000, 300_000, 'duration-ms');
        this.deadline = Date.now() + this.durationMs;
        this.bots = []; this.errors = []; this.closing = false;
        this.rooms = new Map(); this.keys = makeKeys('audit');
        this.redis = new Redis({ host: 'redis', password: process.env.REDIS_PASSWORD,
            maxRetriesPerRequest: 1, connectTimeout: 3_000, commandTimeout: 3_000, retryStrategy: () => null });
        this.redis.on('error', () => { /* caller receives a bounded operation error */ });
        this.poolKey = `audit:bots:pool:${this.seed}`;
        this.stopKey = `audit:bots:stop:${this.seed}`;
        this.poolCredentials = [];
        this.ownsPool = false;
        this.onMetadata = options.onMetadata ?? (() => undefined);
    }
    async request(path, bot, method = 'GET', body, timeoutMs = 8_000) {
        if (!path.startsWith('/api/') || path.includes('://')) throw new Error('Non-audit HTTP path refused');
        const response = await fetch(`http://web${path}`, { method,
            headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                ...(bot ? { authorization: `Bearer ${bot.token}` } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
        let data; try { data = await response.json(); } catch { data = null; }
        const retryHeader = response.headers.get('retry-after');
        const headerDelay = retryHeader && /^\d+(?:\.\d+)?$/.test(retryHeader) ? Number(retryHeader) * 1_000 : 0;
        const bodyDelay = typeof data?.retryAfterMs === 'number' && Number.isFinite(data.retryAfterMs) ? data.retryAfterMs : 0;
        return { status: response.status, data, retryAfterMs: Math.max(headerDelay, bodyDelay, 0) };
    }
    async prepare(count, rampMs = 13_000) {
        bounded(count, 1, 24, 'count'); bounded(rampMs, 0, 60_000, 'ramp-ms');
        bounded(this.bots.length + count, 1, 24, 'total count');
        for (let index = 0; index < count; index++) {
            if (index > 0 && rampMs) await sleep(rampMs);
            this.assertTime();
            let response;
            for (;;) {
                response = await this.request('/api/auth/guest', null, 'POST');
                if (response.status !== 429) break;
                // Preserve deployed security limits. A prior audit may have used
                // the same IP's current window, so wait; never fake forwarded IPs.
                const delay = Math.ceil(Math.max(13_000, response.retryAfterMs));
                this.assertTime(delay + 8_000); await sleep(delay);
            }
            if (response.status !== 201 || typeof response.data?.accessToken !== 'string') throw new Error(`Guest authentication failed (${response.status})`);
            this.bots.push({ index: this.bots.length, token: response.data.accessToken, guest: true,
                socket: null, roomId: null, playerId: null, events: [], frames: [], playing: false,
                sequence: 0, inputCount: 0, inputTimer: null, recovering: false, resumes: 0, requestId: 1 });
            this.onMetadata({ kind: 'authenticated', count: this.bots.length });
        }
        return this.bots;
    }
    assertTime(extraMs = 0) { if (this.closing || Date.now() + extraMs >= this.deadline) throw new Error('Bot duration budget exhausted or stopped'); }
    async savePool() {
        if (await this.redis.exists(this.poolKey)) throw new Error('Bot seed pool already exists; stop it before preparing another');
        await this.redis.set(this.poolKey, JSON.stringify(this.bots.map(bot => ({ token: bot.token, guest: true }))), 'EX', 600);
        this.ownsPool = true;
    }
    async loadPool(count) {
        const raw = await this.redis.get(this.poolKey);
        if (!raw) throw new Error('Prepared seed pool is missing or expired');
        const entries = JSON.parse(raw);
        if (!Array.isArray(entries) || entries.length < count || entries.length > 24) throw new Error('Invalid prepared seed pool');
        if (entries.some(entry => typeof entry?.token !== 'string')) throw new Error('Invalid pool credential');
        this.poolCredentials = entries;
        this.bots = entries.slice(0, count).map((entry, index) => {
            if (typeof entry.token !== 'string') throw new Error('Invalid pool credential');
            return { index, token: entry.token, guest: true, socket: null, roomId: null, playerId: null,
                events: [], frames: [], playing: false, sequence: 0, inputCount: 0, inputTimer: null,
                recovering: false, resumes: 0, requestId: 1 };
        });
        this.ownsPool = true;
    }
    async createRoom(index, capacity = 3, mapId = 'Plaza') {
        if (this.rooms.size >= 8) throw new Error('Audit room limit reached');
        const bot = this.bots[index]; if (!bot || bot.roomId) throw new Error('Bot is already assigned');
        const response = await this.request('/api/rooms', bot, 'POST', {
            name: `봇${this.seed}-${index}`.slice(0, 20), capacity: bounded(capacity, 2, 8, 'capacity'), mapId,
        });
        if (response.status !== 201 || typeof response.data?.ticket !== 'string') throw new Error(`Room create failed (${response.status})`);
        this.rooms.set(response.data.roomId, { owner: index, members: [index] });
        await this.connect(bot, response.data);
        return response.data.roomId;
    }
    async join(index, roomId) {
        const bot = this.bots[index]; if (!bot || bot.roomId) throw new Error('Bot is already assigned');
        const response = await this.request(`/api/rooms/${roomId}/join`, bot, 'POST', {});
        if (response.status !== 201 || typeof response.data?.ticket !== 'string') throw new Error(`Room join failed (${response.status})`);
        this.rooms.get(roomId)?.members.push(index);
        await this.connect(bot, response.data);
    }
    async connect(bot, grant) {
        if (!/^\/game-ws\/[A-Za-z0-9_-]{1,128}$/.test(grant.wsPath) || typeof grant.ticket !== 'string') throw new Error('Invalid audit WebSocket grant');
        bot.roomId = grant.roomId ?? bot.roomId;
        const socket = new WebSocket(`ws://web${grant.wsPath}`, { origin: 'http://web', handshakeTimeout: 3_000, maxPayload: 256_000 });
        bot.socket = socket;
        bot.handshakeStatus = null;
        let authenticated = false;
        socket.on('error', () => undefined);
        socket.on('message', (buffer, binary) => {
            if (binary) {
                try {
                    const frame = decodeSnapshot(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
                    if (bot.frames.length >= 240) bot.frames.shift(); bot.frames.push(frame);
                } catch { this.errors.push({ kind: 'invalid-snapshot', bot: bot.index }); }
                return;
            }
            let event; try { event = JSON.parse(buffer.toString()); } catch { this.errors.push({ kind: 'invalid-event', bot: bot.index }); return; }
            if (bot.events.length >= 500) bot.events.shift(); bot.events.push(event);
            if (event.type === 'auth.ok') { authenticated = true; bot.playerId = event.payload.playerId; bot.playing = event.payload.roomState === 'PLAYING'; }
            if (event.type === 'game.started') bot.playing = true;
            if (event.type === 'game.ended') bot.playing = false;
        });
        socket.on('close', (code) => {
            clearInterval(bot.inputTimer); bot.inputTimer = null;
            if (authenticated && !this.closing && bot.roomId && bot.socket === socket && code !== 1000 && !bot.recovering) {
                void this.resume(bot).catch(() => this.errors.push({ kind: 'resume-failed', bot: bot.index }));
            }
        });
        await new Promise((resolve, reject) => {
            socket.once('open', resolve); socket.once('error', error => {
                const status = /^Unexpected server response: (\d{3})$/.exec(error.message);
                bot.handshakeStatus = status ? Number(status[1]) : null;
                reject(new Error(bot.handshakeStatus ? `Audit socket handshake failed (HTTP ${bot.handshakeStatus})` : 'Audit socket handshake failed'));
            });
        });
        const cursor = bot.events.length;
        socket.send(JSON.stringify({ v: 1, type: 'auth', payload: { ticket: grant.ticket } }));
        const auth = await this.waitEvent(bot, 'auth.ok', cursor, 5_000);
        if (auth.payload.roomId !== bot.roomId) throw new Error('Bot authenticated into unexpected room');
        clearInterval(bot.inputTimer);
        bot.inputTimer = setInterval(() => this.input(bot), 100);
        bot.inputTimer.unref();
    }
    input(bot) {
        if (!bot.playing || bot.socket?.readyState !== WebSocket.OPEN) return;
        const segment = (Math.floor(bot.sequence / 8) + bot.index + this.seed) % 4;
        bot.sequence = (bot.sequence + 1) & 0xffff;
        bot.socket.send(Buffer.from(encodeInput({ sequence: bot.sequence, left: segment === 0,
            right: segment === 1, up: segment === 2, down: segment === 3, heldActions: 0 })));
        bot.inputCount++;
    }
    command(bot, type, payload = {}) {
        if (bot.socket?.readyState !== WebSocket.OPEN) throw new Error('Bot socket is closed');
        const requestId = bot.requestId++;
        bot.socket.send(JSON.stringify({ v: 1, type, requestId, payload }));
        return requestId;
    }
    async start(index) {
        const bot = this.bots[index]; const cursor = bot.events.length;
        // Wait for the legitimate join/map start lock, not a security override.
        for (;;) {
            this.assertTime(1_000);
            const requestId = this.command(bot, 'lobby.start');
            const responseUntil = Date.now() + 1_000;
            let response;
            while (Date.now() < responseUntil) {
                response = bot.events.slice(cursor).find(event => ['game.starting', 'game.started'].includes(event.type)
                    || (event.type === 'error' && event.payload.requestId === requestId));
                if (response) break;
                await sleep(20);
            }
            if (response?.type === 'game.started') return response;
            if (response?.type === 'game.starting') return this.waitEvent(bot, 'game.started', cursor, 15_000);
            if (response?.type === 'error' && !['START_LOCKED', 'RESULT_BACKLOG'].includes(response.payload.code)) throw new Error(`Start rejected (${response.payload.code})`);
            // A quick START_LOCKED reply must not turn this into a busy retry
            // loop and exceed the real 20 JSON commands/second contract.
            if (response?.type === 'error') { this.assertTime(1_000); await sleep(1_000); }
        }
    }
    async resume(bot) {
        bot.recovering = true;
        const roomId = bot.roomId;
        try {
            const deadline = Date.now() + 4_500;
            while (!this.closing && bot.roomId === roomId && Date.now() < deadline) {
                const response = await this.request(`/api/rooms/${roomId}/resume`, bot, 'POST');
                if (response.status === 201 && typeof response.data?.ticket === 'string') {
                    await this.connect(bot, response.data); bot.resumes++;
                    this.onMetadata({ kind: 'resumed', bot: bot.index }); return;
                }
                await sleep(200);
            }
            if (!this.closing) throw new Error('Bot reconnect grace exhausted');
        } finally { bot.recovering = false; }
    }
    async leave(index) {
        const bot = this.bots[index]; if (!bot?.roomId) return;
        const roomId = bot.roomId; const socket = bot.socket;
        bot.roomId = null; bot.playing = false; clearInterval(bot.inputTimer); bot.inputTimer = null;
        if (socket?.readyState === WebSocket.OPEN) {
            this.command(bot, 'lobby.leave');
            await new Promise(resolve => { const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1_000);
                socket.once('close', () => { clearTimeout(timer); resolve(); }); });
        } else socket?.terminate();
        const room = this.rooms.get(roomId); if (room) { room.members = room.members.filter(value => value !== index); if (!room.members.length) this.rooms.delete(roomId); }
    }
    async waitEvent(bot, type, cursor = 0, timeoutMs = 10_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const found = bot.events.slice(cursor).find(event => event.type === type);
            if (found) return found;
            await sleep(20);
        }
        throw new Error(`Bot ${bot.index} did not receive ${type}`);
    }
    async fleet() {
        const ids = await this.redis.zrange(this.keys.gameServersAlive(), 0, -1);
        const values = await Promise.all(ids.map(id => this.redis.get(this.keys.gameServer(id))));
        return values.flatMap(raw => { try { const value = JSON.parse(raw); return value?.updatedAt > Date.now() - 6_000 ? [value] : []; } catch { return []; } });
    }
    async owner(roomId) { const raw = await this.redis.get(this.keys.room(roomId)); return raw ? JSON.parse(raw).serverId : null; }
    async hasActiveClaim(index, roomId, serverId) {
        const bot = this.bots[index];
        const actor = JSON.parse(Buffer.from(bot.token.split('.')[1], 'base64url').toString()).sub;
        if (typeof actor !== 'string' || !/^g:[0-9a-f-]{36}$/i.test(actor)) throw new Error('Invalid audit guest actor');
        const key = this.keys.userActiveRoom(actor);
        const raw = await this.redis.get(key);
        if (!raw) return false;
        const value = JSON.parse(raw);
        return value.state === 'assigned' && value.roomId === roomId && value.serverId === serverId
            && await this.redis.pttl(key) > 1_000;
    }
    async marker(value) { await this.redis.set('audit:scaling:phase', value, 'EX', 300); }
    async logout(bot) {
        // Leave completion and active-claim release can straddle a heartbeat.
        const deadline = Date.now() + 6_000;
        let lastStatus = null;
        while (Date.now() < deadline) {
            const response = await this.request('/api/auth/logout', bot, 'POST', undefined, 2_000).catch(() => null);
            lastStatus = response?.status ?? null;
            if (response?.status === 201 || response?.status === 401) return true;
            if (response && response.status !== 409) break;
            await sleep(250);
        }
        this.errors.push({ kind: 'logout-response', bot: bot.index, status: lastStatus });
        return false;
    }
    async cleanup({ preservePool = false } = {}) {
        if (this.closing) return; this.closing = true;
        await Promise.all(this.bots.map(bot => this.leave(bot.index).catch(() => undefined)));
        if (!preservePool) {
            const credentials = this.poolCredentials.length ? this.poolCredentials : this.bots;
            const results = await Promise.all(credentials.map(bot => this.logout(bot)));
            this.onMetadata({ kind: 'cleanup', attempted: credentials.length, loggedOut: results.filter(Boolean).length });
            if (results.some(value => !value)) this.errors.push({ kind: 'logout-failed' });
            if (this.ownsPool) await this.redis.del(this.poolKey).catch(() => undefined);
        }
        this.redis.disconnect();
    }
}
function optionsFrom(args) {
    const result = {};
    for (let i = 0; i < args.length; i++) {
        const name = args[i];
        if (name === '--reuse') { result.reuse = true; continue; }
        if (name === '--wait-only') { result.waitOnly = true; continue; }
        if (!['--count', '--rooms', '--batch', '--ramp-ms', '--hold-ms', '--duration-ms', '--seed'].includes(name)) throw new Error(`Unknown option ${name}`);
        result[name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = Number(args[++i]);
    }
    return result;
}
async function main(args) {
    assertAuditEnv();
    const action = args[0] && !args[0].startsWith('--') ? args.shift() : 'run';
    if (!['run', 'prepare', 'stop', 'status'].includes(action)) throw new Error('Use run|prepare|stop|status');
    const options = optionsFrom(args);
    const count = bounded(options.count ?? 6, 1, 24, 'count');
    const rooms = bounded(options.rooms ?? Math.ceil(count / 3), 1, Math.min(8, count), 'rooms');
    if (count > rooms * 8) throw new Error('Count exceeds selected rooms capacity');
    const batch = bounded(options.batch ?? 3, 1, 8, 'batch');
    const rampMs = bounded(options.rampMs ?? (options.reuse ? 0 : 13_000), 0, 60_000, 'ramp-ms');
    const holdMs = bounded(options.holdMs ?? 60_000, 0, 180_000, 'hold-ms');
    const load = new AuditBots({ ...options, onMetadata: event => console.log(JSON.stringify(event)) });
    let preservePool = false;
    const deadline = setTimeout(() => { console.error('Bot run reached its duration bound'); void load.cleanup().then(() => process.exit(1)); }, load.durationMs);
    const onSignal = () => { void load.cleanup().then(() => process.exit(0)); };
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
    try {
        if (action === 'status') { preservePool = true; console.log(JSON.stringify({ servers: (await load.fleet()).map(server => ({ serverId: server.serverId, draining: server.draining, rooms: server.waitingRooms + server.playingRooms, connections: server.connections })) })); return; }
        if (action === 'stop') { await load.redis.set(load.stopKey, '1', 'EX', 300); const raw = await load.redis.get(load.poolKey); if (raw) await load.loadPool(JSON.parse(raw).length); return; }
        if (action === 'prepare' && await load.redis.exists(load.poolKey)) throw new Error('Bot seed pool already exists; stop it before preparing another');
        await load.redis.del(load.stopKey);
        if (options.reuse) await load.loadPool(count); else await load.prepare(count, rampMs);
        if (action === 'prepare') { await load.savePool(); preservePool = true; console.log(JSON.stringify({ prepared: count, seed: load.seed, expiresSeconds: 600 })); return; }
        const roomIds = [];
        for (let index = 0; index < rooms; index++) { load.assertTime(); roomIds.push(await load.createRoom(index, Math.max(2, Math.min(8, Math.ceil(count / rooms))))); }
        for (let index = rooms; index < count; index++) {
            load.assertTime(); await load.join(index, roomIds[(index - rooms) % rooms]);
            if ((index - rooms + 1) % batch === 0 && rampMs) { load.assertTime(rampMs); await sleep(rampMs); }
        }
        console.log(JSON.stringify({ connected: count, rooms: rooms, seed: load.seed }));
        let startedRooms = 0;
        if (!options.waitOnly) {
            for (const room of load.rooms.values()) {
                if (room.members.length < 3) continue;
                await load.start(room.owner); startedRooms++;
            }
        }
        console.log(JSON.stringify({ normalMatchesStarted: startedRooms, inputHz: 10, waitingOnly: !!options.waitOnly }));
        load.assertTime(holdMs);
        const holdUntil = Date.now() + holdMs;
        while (Date.now() < holdUntil) {
            load.assertTime();
            if (await load.redis.exists(load.stopKey)) break;
            await sleep(Math.min(500, holdUntil - Date.now()));
        }
        console.log(JSON.stringify({ finished: true, activeRooms: load.rooms.size,
            resumeCount: load.bots.reduce((sum, bot) => sum + bot.resumes, 0),
            inputPacketsSent: load.bots.reduce((sum, bot) => sum + bot.inputCount, 0),
            clientsWithSnapshots: load.bots.filter(bot => bot.frames.length > 0).length,
            clientsWithGameEnd: load.bots.filter(bot => bot.events.some(event => event.type === 'game.ended')).length,
            errors: load.errors }));
        if (load.errors.length) throw new Error('Bot connections reported errors');
    } finally {
        clearTimeout(deadline); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
        await load.cleanup({ preservePool });
        if (load.errors.some(error => error.kind === 'logout-failed')) throw new Error('Bot cleanup could not revoke all synthetic sessions');
    }
}
module.exports = { AuditBots, assertAuditEnv, sleep };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
