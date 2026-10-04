#!/usr/bin/env node
/** Four independent authenticated guests exercise departure and spectator reconnect.
 * node scripts/azure-room-flows-check.cjs --seconds 600 --output e2e/artifacts/azure-room-flows.json
 * Round 1: tagger leave, immediate replacement with 3 survivors, natural finish.
 * Round 2: runner disconnect (immediate elimination), normal resume as spectator,
 *          remaining 3 play to a natural finish. Existing rooms/accounts are untouched.
 */
const assert = require('node:assert/strict');
const { Bot, api, bots, evidence, record, waitFor, sleep, finishEvidence, arg } = require('./azure-multiplayer-check.cjs');
evidence.mode = 'four-player-room-flows';
evidence.ownsRoom = true;
evidence.limitations.push('Disconnect eliminates a participant immediately; reconnect restores a spectator seat, not a living player.');
let movementEnabled = false;
class FlowBot extends Bot {
    drive() { if (movementEnabled && !this.paused) super.drive(); }
    event(message) {
        if (this.reconnecting && message.type === 'game.starting') this.round -= 1;
        super.event(message);
        if (this.reconnecting && message.type === 'game.started') this.reconnecting = false;
    }
    snapshot(snapshot) {
        if (this.expectResumeSnapshot) {
            this.resumeSnapshot = { full: snapshot.full, map: Boolean(snapshot.map), rosterCount: snapshot.roster?.length ?? 0, selfId: snapshot.selfId, tick: snapshot.tick };
            this.expectResumeSnapshot = false;
            record('resume.snapshot', { bot: this.index, ...this.resumeSnapshot });
        }
        super.snapshot(snapshot);
    }
}
function stopTimers(bot) { clearInterval(bot.timer); clearInterval(bot.ping); }
async function connectByCode(bot, code) {
    const grant = await api(`/rooms/code/${encodeURIComponent(code)}/join`, 'POST', bot.token, {});
    await bot.connect(grant);
}
async function beginRound(host, round) {
    await waitFor(() => bots.every((b) => b.lobby?.players.length === 4), 'four independent players in lobby', 20000);
    await sleep((host.lobby.startLockMs || 0) + 700);
    const deadline = Date.now() + 30000;
    while (host.round < round && Date.now() < deadline) { host.send('lobby.start'); await sleep(1000); }
    await waitFor(() => bots.every((b) => b.initial.has(round)), `all four enter round ${round}`, 20000);
    for (const bot of bots) {
        const first = bot.initial.get(round);
        assert.ok(first.full && first.map && first.roster?.length === 4, 'all participants require full MAP/ROSTER');
    }
}
async function resultFor(bot, round, matchId) {
    let result;
    for (let attempt = 0; attempt < 30; attempt++) {
        result = await api(`/matches/${matchId}/result`, 'GET', bot.token);
        if (result.status !== 'pending') break;
        await sleep(1000);
    }
    assert.ok(result && result.status !== 'pending', 'the match result must be persisted');
    assert.equal(result.players.length, 4, 'departed participants remain in the recorded result');
    evidence.results.push({ bot: bot.index, round, ...result });
    record('result.saved', { bot: bot.index, round, matchId, players: result.players.length, winners: result.winners });
    return result;
}
async function lobbyMain() {
    evidence.mode = 'capacity-and-training';
    evidence.ownedRoomIds = [];
    for (let index = 1; index <= 5; index++) bots.push(new FlowBot(index, await api('/auth/guest', 'POST')));
    const grant = await api('/rooms', 'POST', bots[0].token, { name: evidence.runId, capacity: 3, mapId: 'BattleField' });
    evidence.ownedRoomIds.push(grant.roomId);
    await bots[0].connect(grant);
    for (const bot of bots.slice(1, 3)) await connectByCode(bot, grant.roomCode);
    await waitFor(() => bots.slice(0, 3).every((b) => b.lobby?.players.length === 3), 'capacity-three lobby', 10000);
    let capacityRejected = false;
    try { await api(`/rooms/code/${grant.roomCode}/join`, 'POST', bots[3].token, {}); }
    catch (error) { capacityRejected = /HTTP (409|400)/.test(error.message); record('capacity.rejection', { message: error.message }); }
    assert.ok(capacityRejected, 'a fourth guest must not enter a capacity-three room');
    const training = await api('/rooms', 'POST', bots[3].token, { name: `${evidence.runId}-training`, capacity: 1, mode: 'training', mapId: 'TrainingGround' });
    evidence.ownedRoomIds.push(training.roomId);
    await bots[3].connect(training);
    bots[3].send('lobby.start');
    await waitFor(() => bots[3].initial.has(1) && bots[3].playing, 'one guest enters real training simulation', 10000);
    const first = bots[3].initial.get(1);
    assert.ok(first.full && first.map, 'training requires a full initial map');
    assert.equal(bots[3].lobby.players.length, 1);
    let roomsRejected = false;
    try { await api('/rooms', 'POST', bots[4].token, { name: `${evidence.runId}-limit`, capacity: 3 }); }
    catch (error) { roomsRejected = /HTTP (409|503)/.test(error.message); record('room.limit.rejection', { message: error.message }); }
    assert.ok(roomsRejected, 'the configured two-room limit includes the training room');
    const beforeTick = bots[3].latest.tick;
    await sleep(2000);
    assert.ok(bots[3].playing && bots[3].latest.tick > beforeTick && bots[3].ended.length === 0, 'training stays active with one guest');
    evidence.checks = { independentAuthentication: true, roomCapacity: true, onePlayerTraining: true, trainingConsumesRoomLimit: true };
    record('capacity.training.checked', { roomIds: evidence.ownedRoomIds, trainingTick: bots[3].latest.tick });
}
async function main() {
    for (let index = 1; index <= 4; index++) bots.push(new FlowBot(index, await api('/auth/guest', 'POST')));
    assert.equal(new Set(bots.map((b) => b.identity.id)).size, 4);
    const firstGrant = await api('/rooms', 'POST', bots[0].token, { name: evidence.runId, capacity: 4, mapId: arg('--map', 'BattleField') });
    await bots[0].connect(firstGrant);
    for (const bot of bots.slice(1)) await connectByCode(bot, firstGrant.roomCode);
    record('four.guests.ready', { roomId: firstGrant.roomId, roomCode: firstGrant.roomCode });
    const host = bots[1];
    bots[0].send('lobby.passHost', { playerId: host.playerId });
    await waitFor(() => bots.every((b) => b.lobby?.hostId === host.playerId), 'host transfer', 10000);
    host.send('lobby.setMap', { mapId: 'TestMap1' });
    await waitFor(() => bots.every((b) => b.lobby?.mapId === 'TestMap1'), 'map change broadcast', 10000);
    host.send('lobby.setMap', { mapId: arg('--map', 'BattleField') });
    await waitFor(() => bots.every((b) => b.lobby?.mapId === arg('--map', 'BattleField')), 'selected map restored', 10000);
    for (const bot of bots) bot.send('lobby.setLoadout', { skills: ['dash'] });
    await waitFor(() => bots.every((b) => b.lobby?.players.every((p) => p.skills[0] === 'dash')), 'loadout broadcast', 10000);
    evidence.checks.independentAuthentication = true; evidence.checks.hostTransfer = true; evidence.checks.loadouts = true; evidence.checks.mapChange = true;
    record('lobby.checked', { hostId: host.playerId, mapId: host.lobby.mapId, players: host.lobby.players.length });
    await beginRound(host, 1);
    const initialTagger = bots.map((b) => b.latest?.players?.find((p) => p.isTagger)?.id).find((id) => id !== undefined);
    assert.ok(initialTagger, 'an initial tagger is visible to at least their own client');
    const departing = bots.find((b) => b.playerId === initialTagger);
    const survivors = bots.filter((b) => b !== departing);
    const eventOffset = evidence.events.length;
    const departedAt = Date.now();
    stopTimers(departing); departing.send('lobby.leave');
    await waitFor(() => survivors.every((b) => b.lobby?.players.length === 3), 'explicit leave removes the tagger seat', 10000);
    await waitFor(() => evidence.events.slice(eventOffset).some((e) => e.type === 'player.tagged' && e.payload.playerId !== initialTagger), 'immediate replacement tagger event', 5000);
    const replacement = evidence.events.slice(eventOffset).find((e) => e.type === 'player.tagged').payload.playerId;
    await waitFor(() => survivors.find((b) => b.playerId === replacement)?.latest?.players.some((p) => p.id === replacement && p.isTagger), 'replacement is alive and tagged in snapshot', 5000);
    assert.ok(survivors.every((b) => b.playing && b.ended.length === 0), 'three surviving players must keep playing');
    record('tagger.departure.checked', { departedPlayerId: initialTagger, replacementPlayerId: replacement, livingPlayers: 3 });
    evidence.checks.taggerDepartureImmediateReplacement = true;
    movementEnabled = true;
    await waitFor(() => survivors.every((b) => b.ended.length === 1), 'round 1 natural contact victory');
    movementEnabled = false;
    const ended1 = survivors[0].ended[0];
    for (const bot of bots) await resultFor(bot, 1, ended1.matchId);
    for (const bot of survivors) assert.ok(bot.positions.filter((p) => p.round === 1).some((p, _, all) => Math.hypot(p.x - all[0].x, p.y - all[0].y) > 10), 'survivors must actually move');
    assert.ok(evidence.events.some((e) => e.type === 'player.eliminated' && e.payload.playerId !== initialTagger), 'round 1 must include a natural elimination');
    await sleep(Math.max(0, ended1.returnsAt - Date.now()) + 1200);
    // Public joins deliberately enforce a 60-second leave cooldown.
    await sleep(Math.max(0, departedAt + 61_000 - Date.now()));
    await connectByCode(departing, firstGrant.roomCode);
    // A new connection is still the same independent guest identity; it rejoins normally.
    departing.round = 1; departing.ended = [ended1];
    const nextHostId = survivors[0].lobby.hostId;
    const nextHost = bots.find((b) => b.playerId === nextHostId);
    await beginRound(nextHost, 2);
    const round2EventsAt = evidence.events.length;
    const tagger2 = bots.map((b) => b.latest?.players?.find((p) => p.isTagger)?.id).find((id) => id !== undefined);
    const reconnecting = bots.find((b) => b.playerId !== tagger2);
    stopTimers(reconnecting);
    reconnecting.ws.close(1000, 'test network reconnect');
    const remaining = bots.filter((b) => b !== reconnecting);
    await waitFor(() => remaining.some((b) => b.lobby?.players.find((p) => p.playerId === reconnecting.playerId)?.role === 'spectator'), 'disconnect immediately eliminates runner', 3000);
    const grant = await api(`/rooms/${encodeURIComponent(firstGrant.roomId)}/resume`, 'POST', reconnecting.token);
    reconnecting.reconnecting = true; reconnecting.expectResumeSnapshot = true;
    await reconnecting.connect(grant);
    await waitFor(() => reconnecting.resumeSnapshot && reconnecting.role === 'spectator', 'normal ticket restores spectator', 3000);
    assert.ok(reconnecting.resumeSnapshot.full && reconnecting.resumeSnapshot.map && reconnecting.resumeSnapshot.rosterCount === 4);
    assert.equal(reconnecting.resumeSnapshot.selfId, undefined, 'spectator full snapshot has no SELF section');
    assert.ok(remaining.every((b) => b.playing && b.ended.length === 1), 'three survivors continue after reconnect');
    record('spectator.reconnect.checked', { playerId: reconnecting.playerId, role: reconnecting.role, full: true });
    evidence.checks.spectatorReconnect = true;
    movementEnabled = true;
    await waitFor(() => bots.every((b) => b.ended.length === 2), 'round 2 natural contact victory');
    movementEnabled = false;
    const ended2 = bots[0].ended[1];
    assert.notEqual(ended1.matchId, ended2.matchId, 'the next round needs a new match id');
    for (const bot of bots) await resultFor(bot, 2, ended2.matchId);
    for (const bot of remaining) assert.ok(bot.positions.filter((p) => p.round === 2).some((p, _, all) => Math.hypot(p.x - all[0].x, p.y - all[0].y) > 10), 'round 2 must accept restarted input sequences and move');
    assert.ok(evidence.events.slice(round2EventsAt).some((e) => e.type === 'player.eliminated' && e.payload.playerId !== e.payload.by), 'round 2 must include a natural tag elimination');
    evidence.checks.nextRound = true; evidence.checks.recordedParticipantsPreserved = true; evidence.checks.naturalVictory = true;
    evidence.checks.skillsUsed = bots.some((b) => b.positions.some((p) => Object.keys(p.effects || {}).some((effect) => effect !== 'frenzy')));
    assert.ok(evidence.checks.skillsUsed, 'server snapshots must show a successfully applied movement skill');
}
(process.argv.includes('--lobby') ? lobbyMain() : main()).then(() => { evidence.passed = true; }).catch((error) => {
    evidence.passed = false; evidence.failure = error.message; record('failure', { message: error.message }); process.exitCode = 1;
}).finally(finishEvidence);
