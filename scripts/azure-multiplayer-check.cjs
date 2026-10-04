#!/usr/bin/env node
/** Live public-protocol check. Credentials/tickets stay in memory; only evidence is saved.
 * node scripts/azure-multiplayer-check.cjs --room-code CODE --seconds 600
 * node scripts/azure-multiplayer-check.cjs --create --rounds 2 --seconds 600
 * Build shared first. These guests are real, independent authenticated sessions.
 */
const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const { resolve, dirname } = require('node:path');
const WebSocket = require('ws');
const { decodeSnapshot, encodeInput, JSON_MESSAGE_VERSION, SkillSlot, TilePhysics } = require('shared');

const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const create = args.includes('--create');
const roomCode = arg('--room-code');
const base = new URL(arg('--base-url', process.env.BASE_URL || 'https://switch-dev-193234.koreacentral.cloudapp.azure.com/'));
const seconds = Number(arg('--seconds', '600'));
const rounds = Number(arg('--rounds', create ? '2' : '1'));
const output = resolve(arg('--output', `e2e/artifacts/azure-multiplayer/${Date.now()}.json`));
const runId = `az-${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const evidence = { runId, baseUrl: base.origin, startedAt: new Date().toISOString(), mode: create ? 'create' : 'join', events: [], players: [], results: [], checks: {}, limitations: ['Guest sessions cannot request account-only replay tickets.'] };
const bots = [];
let fatal = null;
function record(type, fields = {}) {
    const event = { at: new Date().toISOString(), type, ...fields };
    if (evidence.events.length < 4000) evidence.events.push(event);
    console.log(JSON.stringify(event));
}
async function api(path, method, token, body) {
    const response = await fetch(new URL(`/api${path}`, base), {
        method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000),
    });
    let data;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) throw new Error(`HTTP ${response.status} ${method} ${path}`);
    return data;
}
function sanitized(value) {
    if (Array.isArray(value)) return value.map(sanitized);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/token|ticket|secret|password|authorization|cookie/i.test(key))
        .map(([key, child]) => [key, sanitized(child)]));
    return value;
}
function nextWaypoint(map, own, target) {
    const tileSize = 256;
    const inside = (x, y) => x >= 0 && y >= 0 && x < map.cols && y < map.rows;
    const walkable = (x, y) => inside(x, y) && map.tiles[y][x] !== TilePhysics.Wall;
    const start = [Math.floor(own.x / tileSize), Math.floor(own.y / tileSize)];
    let goal = target ? [Math.floor(target.x / tileSize), Math.floor(target.y / tileSize)] : [Math.floor(map.cols / 2), Math.floor(map.rows / 2)];
    if (!walkable(...goal)) {
        const candidates = [];
        for (let y = 0; y < map.rows; y++) for (let x = 0; x < map.cols; x++) if (walkable(x, y)) candidates.push([x, y]);
        candidates.sort((a, b) => Math.hypot(a[0] - goal[0], a[1] - goal[1]) - Math.hypot(b[0] - goal[0], b[1] - goal[1]));
        goal = candidates[0] || start;
    }
    const key = (point) => point.join(',');
    const queue = [start], previous = new Map([[key(start), null]]);
    let found = null;
    for (let head = 0; head < queue.length; head++) {
        const point = queue[head];
        if (key(point) === key(goal)) { found = point; break; }
        for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
            const next = [point[0] + dx, point[1] + dy];
            if (!walkable(...next) || previous.has(key(next))) continue;
            previous.set(key(next), point); queue.push(next);
        }
    }
    if (!found) return null;
    let point = found;
    while (previous.get(key(point)) && key(previous.get(key(point))) !== key(start)) point = previous.get(key(point));
    if (key(point) === key(start) && target) return target;
    return { x: (point[0] + 0.5) * tileSize, y: (point[1] + 0.5) * tileSize };
}
class Bot {
    constructor(index, identity) {
        this.index = index; this.token = identity.accessToken; this.identity = identity.guest;
        this.ws = null; this.request = 0; this.sequence = 0; this.round = 0; this.playing = false;
        this.role = 'player'; this.ended = []; this.initial = new Map(); this.positions = [];
        this.latest = null; this.map = null; this.lobby = null; this.skillSent = false; this.switchSent = false;
        evidence.players.push({ index, guestId: identity.guest.id, nickname: identity.guest.nickname });
    }
    send(type, payload = {}) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ v: JSON_MESSAGE_VERSION, requestId: ++this.request, type, payload }));
    }
    async connect(grant) {
        this.roomId = grant.roomId; this.roomCode = grant.roomCode;
        const url = new URL(grant.wsPath, base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = this.ws = new WebSocket(url, { origin: base.origin });
        await new Promise((done, reject) => {
            const timeout = setTimeout(() => reject(new Error('WebSocket authentication timeout')), 20000);
            ws.on('open', () => this.send('auth', { ticket: grant.ticket }));
            ws.on('error', () => { clearTimeout(timeout); reject(new Error('WebSocket connection error')); });
            ws.on('message', (data, binary) => {
                try {
                    if (binary) return this.snapshot(decodeSnapshot(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
                    const message = JSON.parse(data.toString());
                    if (message.type === 'auth.ok') { this.playerId = message.payload.playerId; clearTimeout(timeout); done(); }
                    this.event(message);
                } catch (error) { fatal = error; }
            });
            ws.on('close', (code) => { this.playing = false; record('socket.closed', { bot: this.index, code }); });
        });
        this.timer = setInterval(() => this.drive(), 100);
        this.ping = setInterval(() => this.send('ping', { clientTime: Date.now() }), 5000);
        record('authenticated', { bot: this.index, playerId: this.playerId, roomId: this.roomId, roomCode: this.roomCode });
    }
    event(message) {
        const { type, payload } = message;
        if (type === 'lobby.state') {
            this.lobby = payload; this.playerId = payload.selfId ?? this.playerId;
            this.role = payload.players.find((player) => player.playerId === this.playerId)?.role ?? this.role;
        }
        if (type === 'game.starting') { this.round += 1; this.playing = false; this.sequence = 0; this.map = null; this.latest = null; this.skillSent = false; this.switchSent = false; }
        if (type === 'game.started') this.playing = true;
        if (type === 'game.ended') { this.playing = false; this.ended.push(payload); }
        if (type === 'spectate.changed' && payload.playerId === this.playerId) this.role = payload.spectating ? 'spectator' : 'player';
        if (type !== 'pong' && type !== 'lobby.state') record(type, { bot: this.index, payload: sanitized(payload) });
    }
    snapshot(snapshot) {
        this.latest = snapshot;
        if (!this.initial.has(this.round)) {
            const first = { round: this.round, bot: this.index, tick: snapshot.tick, full: snapshot.full, map: Boolean(snapshot.map), roster: snapshot.roster?.map((p) => ({ id: p.id, nickname: p.nickname })), selfId: snapshot.selfId, players: snapshot.players?.map((p) => ({ id: p.id, x: p.x, y: p.y })) };
            this.initial.set(this.round, first); record('first.snapshot', first);
        }
        if (snapshot.map) this.map = snapshot.map;
        for (const tile of snapshot.tileChanges || []) if (this.map?.tiles[tile.y]) this.map.tiles[tile.y][tile.x] = tile.physics;
        const self = snapshot.players?.find((p) => p.id === this.playerId);
        if (self && this.positions.length < 10000) this.positions.push({ round: this.round, tick: snapshot.tick, x: self.x, y: self.y, effects: self.effects });
    }
    drive() {
        if (!this.playing || this.role !== 'player' || this.ws?.readyState !== WebSocket.OPEN) return;
        const own = this.latest?.players?.find((p) => p.id === this.playerId);
        if (!own) return;
        const others = this.latest.players.filter((p) => p.id !== this.playerId);
        const tagger = this.latest.players.find((p) => p.isTagger);
        const target = own.isTagger ? others.sort((a, b) => Math.hypot(a.x - own.x, a.y - own.y) - Math.hypot(b.x - own.x, b.y - own.y))[0] : tagger;
        let dx = target ? target.x - own.x : Math.sin(Date.now() / 2000 + this.index) * 1000;
        let dy = target ? target.y - own.y : Math.cos(Date.now() / 2000 + this.index) * 1000;
        // Route around walls using only the public snapshot, then submit input intent.
        const waypoint = this.map ? nextWaypoint(this.map, own, target) : null;
        if (waypoint) { dx = waypoint.x - own.x; dy = waypoint.y - own.y; }
        this.ws.send(Buffer.from(encodeInput({ sequence: this.sequence++ & 65535, left: dx < -8, right: dx > 8, up: dy < -8, down: dy > 8, heldActions: 0 })));
        if (!this.skillSent) { this.skillSent = true; this.send('game.useSkill', { slot: SkillSlot.Movement }); }
        if (!this.switchSent && !own.isTagger && tagger && Math.hypot(tagger.x - own.x, tagger.y - own.y) < 330) {
            const runner = others.find((p) => !p.isTagger);
            if (runner) { this.switchSent = true; this.send('game.useSkill', { slot: SkillSlot.Switch, targetPlayerId: runner.id }); }
        }
    }
    close() {
        clearInterval(this.timer); clearInterval(this.ping);
        this.send('lobby.leave');
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(1000, 'test completed');
    }
}
async function waitFor(predicate, description, timeoutMs = seconds * 1000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (fatal) throw fatal;
        if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
        await sleep(250);
    }
}
async function main() {
    assert.ok(create || roomCode, 'Pass --create or --room-code CODE');
    assert.ok(Number.isFinite(seconds) && seconds > 0 && Number.isSafeInteger(rounds) && rounds > 0);
    for (let index = 1; index <= (create ? 3 : 2); index++) {
        const identity = await api('/auth/guest', 'POST');
        bots.push(new Bot(index, identity));
    }
    assert.equal(new Set(bots.map((b) => b.identity.id)).size, bots.length, 'Each player needs an independent guest identity');
    let code = roomCode;
    for (const bot of bots) {
        const grant = create && bot.index === 1
            ? await api('/rooms', 'POST', bot.token, { name: runId.slice(-20), capacity: 3, mapId: arg('--map', 'BattleField') })
            : await api(`/rooms/code/${encodeURIComponent(code)}/join`, 'POST', bot.token, {});
        code = grant.roomCode; await bot.connect(grant);
        bot.send('lobby.setLoadout', { skills: ['dash'] });
    }
    record('ready', { roomId: bots[0].roomId, roomCode: code, independentGuests: bots.length });
    for (let round = 1; round <= rounds; round++) {
        if (create) {
            await waitFor(() => bots.every((b) => b.lobby?.players.length === 3), 'three-player lobby', 20000);
            await sleep((bots[0].lobby.startLockMs || 0) + 600);
            const deadline = Date.now() + 30000;
            while (bots[0].round < round && Date.now() < deadline) { bots[0].send('lobby.start'); await sleep(1000); }
        }
        await waitFor(() => bots.every((b) => b.initial.has(round)), `all clients enter round ${round}`);
        for (const bot of bots) {
            const first = bot.initial.get(round);
            if (!args.includes('--observe')) assert.ok(first.full && first.map && first.roster?.length >= 3, `bot ${bot.index} round ${round}: initial full MAP/ROSTER missing`);
        }
        await waitFor(() => bots.every((b) => b.ended.length >= round), `round ${round} natural victory`);
        for (const bot of bots) {
            const ended = bot.ended[round - 1];
            let result;
            for (let attempt = 0; attempt < 30; attempt++) {
                result = await api(`/matches/${ended.matchId}/result`, 'GET', bot.token);
                if (result.status !== 'pending') break;
                await sleep(1000);
            }
            assert.ok(result && result.status !== 'pending', 'Result persisted within 30 seconds');
            assert.equal(result.players.length, 3); evidence.results.push({ bot: bot.index, round, ...sanitized(result) });
            record('result.saved', { bot: bot.index, round, matchId: ended.matchId, players: result.players.length, winners: result.winners });
            const positions = bot.positions.filter((p) => p.round === round);
            assert.ok(positions.some((p) => p.x !== positions[0]?.x || p.y !== positions[0]?.y), `bot ${bot.index}: server-authoritative movement required`);
        }
        if (round < rounds) await sleep(Math.max(0, bots[0].ended[round - 1].returnsAt - Date.now()) + 1200);
    }
    evidence.checks = { independentAuthentication: true, initialFullSnapshots: bots.every((b) => [...b.initial.values()].every((f) => f.full && f.map && f.roster?.length >= 3)), authoritativeMovement: true, endedAndSaved: true, rounds };
}
async function finishEvidence() {
    for (const bot of bots) bot.close();
    await sleep(1500);
    if ((create || evidence.ownsRoom) && bots[0]) {
        try {
            const listing = await api('/rooms', 'GET', bots[0].token);
            const ownIds = evidence.ownedRoomIds || [bots[0].roomId];
            // This endpoint exposes one page of waiting rooms, not the authoritative Redis room directory.
            evidence.checks.ownRoomAbsentFromPublicWaitingList = !listing.rooms.some((room) => ownIds.includes(room.id));
            evidence.limitations.push('Cleanup listing checks only the first public waiting-room page; confirm authoritative room removal separately in Redis.');
            if (!evidence.checks.ownRoomAbsentFromPublicWaitingList) { evidence.passed = false; process.exitCode = 1; }
        } catch { evidence.checks.ownRoomAbsentFromPublicWaitingList = 'unverified'; }
    }
    evidence.finishedAt = new Date().toISOString();
    evidence.snapshots = bots.flatMap((bot) => [...bot.initial.values()]);
    evidence.movements = bots.map((bot) => ({ bot: bot.index, positions: bot.positions.filter((_, index) => index % 10 === 0) }));
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(sanitized(evidence), null, 2));
    console.log(`Evidence: ${output}`);
}
module.exports = { Bot, api, bots, evidence, record, waitFor, sleep, sanitized, finishEvidence, arg, args };
if (require.main === module) main().then(() => { evidence.passed = true; }).catch((error) => {
    evidence.passed = false; evidence.failure = error.message; record('failure', { message: error.message }); process.exitCode = 1;
}).finally(finishEvidence);
