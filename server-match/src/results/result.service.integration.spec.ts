import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { MATCH_RESULT_VERSION, matchXp, type MatchResultMessage } from 'shared';
import { auditContext } from '../admin/audit-log';
import * as schema from '../database/schema';
import { MatchesService } from '../matches/matches.service';
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
    let scrubAuditId: number | null = null;
    let deleteAuditId: number | null = null;
    try {
        const [scrubEntry] = await db.insert(schema.adminAuditLog).values({
            actor: `integration-${suffix}`,
            action: 'RETENTION_TRIGGER_TEST',
            targetType: 'integration',
            targetId: `scrub-${suffix}`,
            reason: 'verify append-only trigger',
            requestMeta: auditContext().requestMeta,
            ipEncrypted: 'v1:integration',
        }).returning({ id: schema.adminAuditLog.id });
        scrubAuditId = scrubEntry.id;

        await assert.rejects(
            db.update(schema.adminAuditLog).set({ ipEncrypted: null })
                .where(eq(schema.adminAuditLog.id, scrubAuditId)),
            /admin_audit_log is append only/,
        );
        await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT set_config('switch.audit_retention', 'on', true)`);
            await tx.update(schema.adminAuditLog).set({ ipEncrypted: null })
                .where(eq(schema.adminAuditLog.id, scrubAuditId!));
        });
        const [scrubbed] = await db.select({ ipEncrypted: schema.adminAuditLog.ipEncrypted })
            .from(schema.adminAuditLog).where(eq(schema.adminAuditLog.id, scrubAuditId));
        assert.equal(scrubbed.ipEncrypted, null);

        const [deleteEntry] = await db.insert(schema.adminAuditLog).values({
            actor: `integration-${suffix}`,
            action: 'RETENTION_TRIGGER_TEST',
            targetType: 'integration',
            targetId: `delete-${suffix}`,
            reason: 'verify append-only trigger',
            requestMeta: auditContext().requestMeta,
        }).returning({ id: schema.adminAuditLog.id });
        deleteAuditId = deleteEntry.id;

        await assert.rejects(
            db.delete(schema.adminAuditLog).where(eq(schema.adminAuditLog.id, deleteAuditId)),
            /admin_audit_log is append only/,
        );
        await assert.rejects(
            db.transaction(async (tx) => {
                await tx.execute(sql`SELECT set_config('switch.audit_retention', 'on', true)`);
                await tx.update(schema.adminAuditLog).set({ reason: 'not a retention mutation' })
                    .where(eq(schema.adminAuditLog.id, deleteAuditId!));
            }),
            /admin_audit_log is append only/,
        );
        await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT set_config('switch.audit_retention', 'on', true)`);
            await tx.delete(schema.adminAuditLog).where(eq(schema.adminAuditLog.id, deleteAuditId!));
        });
        deleteAuditId = null;

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
            winnerPlayerIds: [1],
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
        assert.deepEqual(
            participants.sort((left, right) => left.playerId - right.playerId)
                .map((participant) => ({ playerId: participant.playerId, isWinner: participant.isWinner })),
            [{ playerId: 1, isWinner: true }, { playerId: 2, isWinner: false }],
        );
        const snapshot = await new MatchesService(db).getResult(matchId, user.id);
        assert.ok(!('status' in snapshot));
        assert.deepEqual(snapshot.winners, ['1']);
        const [storedUser] = await db.select({ stats: schema.users.stats }).from(schema.users)
            .where(eq(schema.users.id, user.id));
        const stats = storedUser.stats as Record<string, number>;
        assert.deepEqual(
            { games: stats.games, wins: stats.wins, sw_try: stats.sw_try, sw_su: stats.sw_su, kill: stats.kill },
            { games: 1, wins: 1, sw_try: 4, sw_su: 3, kill: 2 },
        );
        // XP는 결과에서 오른다. 레벨은 저장하지 않는다 — 읽을 때 XP에서 센다.
        assert.equal(stats.xp, matchXp({ won: true, tagCount: 2, switchSuccess: 3 }));
    } finally {
        const auditIds = [scrubAuditId, deleteAuditId].filter((id): id is number => id !== null);
        if (auditIds.length > 0) {
            await db.transaction(async (tx) => {
                await tx.execute(sql`SELECT set_config('switch.audit_retention', 'on', true)`);
                for (const id of auditIds) {
                    await tx.delete(schema.adminAuditLog).where(eq(schema.adminAuditLog.id, id));
                }
            });
        }
        await db.delete(schema.matches).where(eq(schema.matches.matchId, matchId));
        if (userId !== null) await db.delete(schema.users).where(eq(schema.users.id, userId));
        await connection.end();
    }
});
