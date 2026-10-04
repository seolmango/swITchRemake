import { test, expect } from '@playwright/test';
import { database } from './helpers';

test('real bots increase worker capacity, drain migrates a waiting room, and another match persists', async ({}, testInfo) => {
    test.setTimeout(300_000);
    const { AuditBots, sleep } = require('../../scripts/audit-bots.cjs');
    const bots = new AuditBots({ seed: 41004, durationMs: 295_000 });
    const db = database();
    const evidence: object[] = [];
    const until = async (condition: () => Promise<boolean>, message: string, timeout = 35_000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) { if (await condition()) return; await sleep(250); }
        throw new Error(message);
    };
    try {
        await until(async () => (await bots.fleet()).length === 1, 'Initial one-worker capacity missing');
        const initial = (await bots.fleet())[0].serverId;
        await bots.marker('initial-one');
        // Guest auth rate stays <=5/minute; all six sockets then attach in a burst.
        await bots.prepare(6, 13_000);
        const playingRoom = await bots.createRoom(0, 3);
        await bots.join(1, playingRoom); await bots.join(2, playingRoom);
        const temporaryB = await bots.createRoom(3, 3);
        const temporaryC = await bots.createRoom(4, 3);
        await until(async () => (await bots.fleet()).filter((server: any) => !server.draining).length === 2, 'Supervisor did not scale up');
        const fleetUp = await bots.fleet();
        expect(new Set(fleetUp.map((server: any) => server.serverId)).size).toBe(2);
        await bots.marker('scaled-two');
        // Leave time for the host monitor to capture independent OS process evidence.
        await sleep(1_500);
        const waitingRoom = await bots.createRoom(5, 3);
        const waitingOwner = await bots.owner(waitingRoom);
        expect(waitingOwner).not.toBe(initial);
        await bots.start(0);
        await until(async () => bots.bots.slice(0, 3).every((bot: any) => bot.playing), 'All three normal clients did not start', 5_000);
        await bots.leave(3); await bots.leave(4);
        await until(async () => bots.bots[5].resumes >= 1, 'Waiting-room bot did not recover after drain', 40_000);
        const adoptedAt = Date.now();
        await until(async () => (await bots.fleet()).length === 1, 'Drained worker did not exit', 35_000);
        expect(await bots.owner(waitingRoom)).toBe(initial);
        expect(bots.bots[5].socket.readyState).toBe(1);
        await bots.marker('drained-one');
        await sleep(1_500);
        const ended = await bots.waitEvent(bots.bots[0], 'game.ended', 0, 120_000);
        await until(async () => {
            const [stored] = await db`select result_recorded_at from matches where match_id=${ended.payload.matchId}`;
            return !!stored?.result_recorded_at;
        }, 'Match result was not persisted', 25_000);
        const rows = await db`select * from match_participants where match_id=${ended.payload.matchId}`;
        expect(rows).toHaveLength(3); expect(rows.every(row => row.is_guest && row.user_id === null)).toBe(true);
        expect(bots.bots.slice(0, 3).every((bot: any) => bot.events.some((event: any) => event.type === 'game.ended'))).toBe(true);
        expect(bots.bots.slice(0, 3).every((bot: any) => bot.inputCount > 0 && bot.frames.length > 1
            && bot.frames.at(-1).tick > bot.frames[0].tick)).toBe(true);
        if (Date.now() - adoptedAt < 35_000) await sleep(35_000 - (Date.now() - adoptedAt));
        expect(await bots.hasActiveClaim(5, waitingRoom, initial), 'Adopted active claim survives its original 30s TTL').toBe(true);
        // Finish the existing match first, then run a new real match in the
        // adopted room without changing the live scaling policy.
        await Promise.all([0, 1, 2].map(index => bots.leave(index)));
        await until(async () => await bots.owner(playingRoom) === null, 'Finished room did not clean up', 10_000);
        await bots.join(3, waitingRoom); await bots.join(4, waitingRoom);
        await bots.start(5);
        await until(async () => [3, 4, 5].every(index => bots.bots[index].playing), 'Migrated match did not start for all clients', 5_000);
        const migratedEnd = await bots.waitEvent(bots.bots[5], 'game.ended', 0, 120_000);
        await until(async () => {
            const [stored] = await db`select result_recorded_at, server_id from matches where match_id=${migratedEnd.payload.matchId}`;
            return !!stored?.result_recorded_at && stored.server_id === initial;
        }, 'Migrated room result authority was not persisted on the adopter', 25_000);
        const migratedRows = await db`select * from match_participants where match_id=${migratedEnd.payload.matchId}`;
        expect(migratedRows).toHaveLength(3);
        expect(migratedRows.every(row => row.is_guest && row.user_id === null)).toBe(true);
        expect([3, 4, 5].every(index => bots.bots[index].events.some((event: any) => event.type === 'game.ended'))).toBe(true);
        expect([3, 4, 5].every(index => bots.bots[index].inputCount > 0 && bots.bots[index].frames.length > 1
            && bots.bots[index].frames.at(-1).tick > bots.bots[index].frames[0].tick)).toBe(true);
        expect((await bots.fleet()).length).toBe(1);
        expect(bots.errors).toEqual([]);
        evidence.push({ initialWorkers: 1, scaledWorkers: 2, drainedWorkers: 1, normalInputHz: 10,
            guestBots: 6, waitingRoomResumed: true, currentMatchContinued: true,
            persistedParticipants: rows.length + migratedRows.length, migratedRoomMatchPersisted: true,
            adoptedClaimRenewedBeyondOriginalTtl: true, syntheticGuestResult: true });
        await testInfo.attach('scaling-evidence.json', { body: JSON.stringify(evidence), contentType: 'application/json' });
        await bots.marker('complete');
    } finally {
        try {
            await bots.cleanup();
            expect(bots.errors.some((error: any) => error.kind === 'logout-failed'), 'Synthetic bot sessions cleaned up').toBe(false);
        } finally { await db.end(); }
    }
});
