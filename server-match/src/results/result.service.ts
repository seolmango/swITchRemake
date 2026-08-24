import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
    statsEligible,
    winnerUserIds,
    type ActorId,
    type MatchResultMessage,
} from 'shared';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';

export interface AssignedActor {
    id: ActorId;
    nickname: string;
    guest: boolean;
}

export type RecordResult = 'stored' | 'duplicate' | 'invalid';

@Injectable()
export class ResultService {
    constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>) {}

    async issueMatch(matchId: string, serverId: string, mapId: string, owner: AssignedActor): Promise<void> {
        await this.db.transaction(async (tx) => {
            await tx.insert(schema.matches).values({ matchId, serverId, mapId });
            await tx.insert(schema.matchAssignments).values(this.assignment(matchId, owner));
        });
    }

    async confirmRoom(matchId: string, roomId: string, mapId: string): Promise<void> {
        await this.db.update(schema.matches).set({ roomId, mapId }).where(eq(schema.matches.matchId, matchId));
    }

    async discardIssuedMatch(matchId: string): Promise<void> {
        await this.db.delete(schema.matches).where(and(
            eq(schema.matches.matchId, matchId),
            isNull(schema.matches.resultRecordedAt),
        ));
    }

    async addAssignmentByRoom(roomId: string, actor: AssignedActor): Promise<string | null> {
        return this.db.transaction(async (tx) => {
            const [match] = await tx.select({ matchId: schema.matches.matchId })
                .from(schema.matches)
                .where(and(eq(schema.matches.roomId, roomId), isNull(schema.matches.resultRecordedAt)))
                .for('update');
            if (!match) return null;
            await tx.insert(schema.matchAssignments)
                .values(this.assignment(match.matchId, actor))
                .onConflictDoNothing();
            return match.matchId;
        });
    }

    async removeAssignment(matchId: string, actorId: ActorId): Promise<void> {
        await this.db.delete(schema.matchAssignments).where(and(
            eq(schema.matchAssignments.matchId, matchId),
            eq(schema.matchAssignments.actorId, String(actorId)),
        ));
    }

    async record(result: MatchResultMessage): Promise<RecordResult> {
        return this.db.transaction(async (tx) => {
            const [match] = await tx.select().from(schema.matches)
                .where(eq(schema.matches.matchId, result.matchId))
                .for('update');
            if (!match) return 'invalid';
            if (match.resultRecordedAt) return 'duplicate';
            if ((match.roomId !== null && match.roomId !== result.roomId)
                || match.serverId !== result.serverId
                || match.mapId !== result.mapId) {
                return 'invalid';
            }

            const assignments = await tx.select().from(schema.matchAssignments)
                .where(eq(schema.matchAssignments.matchId, result.matchId));
            if (!this.isAssignedParticipantSubset(result, assignments)) return 'invalid';

            const committedAt = new Date();
            const updated = await tx.update(schema.matches).set({
                roomId: result.roomId,
                startedAt: new Date(result.startedAt),
                endedAt: new Date(result.endedAt),
                durationTicks: result.durationTicks,
                buildId: result.buildId,
                protocolVersion: result.protocolVersion,
                rulesVersion: result.rulesVersion,
                mapBundleHash: result.mapBundleHash,
                visibilityCoreVersion: result.visibilityCoreVersion,
                resultRecordedAt: committedAt,
            }).where(and(
                eq(schema.matches.matchId, result.matchId),
                isNull(schema.matches.resultRecordedAt),
            )).returning({ matchId: schema.matches.matchId });
            if (!updated.length) return 'duplicate';

            const winners = new Set(result.winnerPlayerIds);
            await tx.insert(schema.matchParticipants).values(result.players.map((player) => ({
                matchId: result.matchId,
                userId: player.userId,
                playerId: player.playerId,
                nickname: player.nickname,
                colorIndex: player.colorIndex,
                isGuest: player.isGuest,
                isWinner: winners.has(player.playerId),
                tagCount: player.tagCount,
                taggedCount: player.taggedCount,
                switchTry: player.switchTry,
                switchSuccess: player.switchSuccess,
                survivedMs: player.survivedMs,
            })));

            if (result.replay) {
                await tx.insert(schema.replays).values({
                    matchId: result.matchId,
                    storageKey: result.replay.storageKey,
                    formatVersion: result.replay.formatVersion,
                    chunkCount: result.replay.chunkCount,
                    sizeBytes: result.replay.sizeBytes,
                    rootHash: result.replay.rootHash,
                    status: 'available',
                });
            }

            const winningUsers = new Set(winnerUserIds(result));
            for (const player of statsEligible(result.players)) {
                await tx.execute(sql`
                    UPDATE ${schema.users}
                    SET stats = stats || jsonb_build_object(
                        'games', COALESCE((stats ->> 'games')::integer, 0) + 1,
                        'wins', COALESCE((stats ->> 'wins')::integer, 0) + ${winningUsers.has(player.userId!) ? 1 : 0},
                        'sw_try', COALESCE((stats ->> 'sw_try')::integer, 0) + ${player.switchTry},
                        'sw_su', COALESCE((stats ->> 'sw_su')::integer, 0) + ${player.switchSuccess},
                        'kill', COALESCE((stats ->> 'kill')::integer, 0) + ${player.tagCount}
                    ), updated_at = now()
                    WHERE id = ${player.userId!}
                `);
            }
            return 'stored';
        });
    }

    private assignment(matchId: string, actor: AssignedActor) {
        return {
            matchId,
            actorId: String(actor.id),
            userId: actor.guest ? null : actor.id as number,
            nickname: actor.nickname,
            isGuest: actor.guest,
        };
    }

    private isAssignedParticipantSubset(
        result: MatchResultMessage,
        assignments: Array<typeof schema.matchAssignments.$inferSelect>,
    ): boolean {
        const accountAssignments = new Map(
            assignments.filter((item) => !item.isGuest && item.userId !== null)
                .map((item) => [item.userId!, item.nickname]),
        );
        const guestNames = new Map<string, number>();
        for (const assignment of assignments.filter((item) => item.isGuest)) {
            guestNames.set(assignment.nickname, (guestNames.get(assignment.nickname) ?? 0) + 1);
        }
        for (const player of result.players) {
            if (player.isGuest) {
                const remaining = guestNames.get(player.nickname) ?? 0;
                if (remaining === 0) return false;
                guestNames.set(player.nickname, remaining - 1);
            } else if (player.userId === null || accountAssignments.get(player.userId) !== player.nickname) {
                return false;
            }
        }
        return true;
    }
}
