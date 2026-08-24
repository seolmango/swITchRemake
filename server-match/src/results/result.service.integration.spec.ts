import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { MATCH_RESULT_VERSION, type MatchResultMessage } from 'shared';
import * as schema from '../database/schema';
import { ResultService } from './result.service';

// The regular unit-test command does not load ../.env, so this remains opt-in.
// Run directly with: node --env-file=../.env --test <compiled file>.
const runIntegration = Boolean(process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER);

test('stores one idempotent result transaction and excludes guest stats', { skip: !runIntegration }, async () => {
    loadEnv({ path: path.resolve(process.cwd(), '../.env') });
    const connection = postgres(
        `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
    );
    const db = drizzle(connection, { schema });
    const service = new ResultService(db);
    const suffix = Date.now().toString(36);
    const matchId = '22222222-2222-4222-8222-222222222222';
    let userId: number | null = null;
    try {
        await db.delete(schema.matches).where(eq(schema.matches.matchId, matchId));
        const [user] = await db.insert(schema.users).values({
            email: `a2-${suffix}@example.invalid`,
            passwordHash: 'integration-only',
            nickname: `A2_${suffix}`.slice(0, 20),
        }).returning({ id: schema.users.id });
        userId = user.id;

        await service.issueMatch(matchId, 'game-a2', 'map-a2', {
            id: user.id, nickname: `A2_${suffix}`.slice(0, 20), guest: false,
        });
        await service.confirmRoom(matchId, 'room-a2', 'map-a2');
        await service.addAssignmentByRoom('room-a2', {
            id: 'g:33333333-3333-4333-8333-333333333333', nickname: 'Guest_7KPW2M', guest: true,
        });

        const result: MatchResultMessage = {
            v: MATCH_RESULT_VERSION,
            matchId, roomId: 'room-a2', serverId: 'game-a2', mapId: 'map-a2',
            startedAt: 1_000, endedAt: 61_000, durationTicks: 1_800,
            buildId: 'integration', protocolVersion: 1, rulesVersion: 'rules-a2',
            mapBundleHash: 'bundle-a2', visibilityCoreVersion: 1,
            winnerPlayerIds: [1, 2],
            replay: {
                storageKey: 'integration/a2.swrp', formatVersion: 1, chunkCount: 1,
                sizeBytes: 100, rootHash: 'a'.repeat(64),
            },
            players: [
                { userId: user.id, playerId: 1, nickname: `A2_${suffix}`.slice(0, 20), colorIndex: 0, isGuest: false, tagCount: 2, taggedCount: 1, switchTry: 4, switchSuccess: 3, survivedMs: 60_000 },
                { userId: null, playerId: 2, nickname: 'Guest_7KPW2M', colorIndex: 1, isGuest: true, tagCount: 5, taggedCount: 0, switchTry: 9, switchSuccess: 8, survivedMs: 60_000 },
            ],
        };

        const forged = structuredClone(result);
        forged.players[1].nickname = 'Guest_8KPW2M';
        assert.equal(await service.record(forged), 'invalid');
        assert.equal(await service.record(result), 'stored');
        assert.equal(await service.record(result), 'duplicate');
        const participants = await db.select().from(schema.matchParticipants)
            .where(eq(schema.matchParticipants.matchId, matchId));
        assert.equal(participants.length, 2);
        assert.equal(participants.find((participant) => participant.isGuest)?.userId, null);
        const [storedUser] = await db.select({ stats: schema.users.stats }).from(schema.users)
            .where(eq(schema.users.id, user.id));
        const stats = storedUser.stats as Record<string, number>;
        assert.deepEqual(
            { games: stats.games, wins: stats.wins, sw_try: stats.sw_try, sw_su: stats.sw_su, kill: stats.kill },
            { games: 1, wins: 1, sw_try: 4, sw_su: 3, kill: 2 },
        );
    } finally {
        await db.delete(schema.matches).where(eq(schema.matches.matchId, matchId));
        if (userId !== null) await db.delete(schema.users).where(eq(schema.users.id, userId));
        await connection.end();
    }
});
