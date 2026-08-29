import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
    matchXp,
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

    /**
     * 배정은 "이 방에 들여보낸 사람"이라 방이 치르는 경기보다 오래 산다. 아직 결과가 안 들어온 행을
     * 먼저 보되, 직전 경기가 이미 기록된 뒤(= 재경기 대기 중)라면 가장 최근 행에 붙인다. 예전에는
     * 미기록 행만 찾아서, 한 경기가 끝난 방에는 아무도 새로 들어올 수 없었다.
     */
    async addAssignmentByRoom(roomId: string, actor: AssignedActor): Promise<string | null> {
        return this.db.transaction(async (tx) => {
            const [match] = await tx.select({ matchId: schema.matches.matchId })
                .from(schema.matches)
                .where(eq(schema.matches.roomId, roomId))
                .orderBy(sql`${schema.matches.resultRecordedAt} IS NULL DESC`, desc(schema.matches.createdAt))
                .limit(1)
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
            const [existing] = await tx.select().from(schema.matches)
                .where(eq(schema.matches.matchId, result.matchId))
                .for('update');
            const match = existing ?? await this.issueRematch(tx, result);
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
                const won = winningUsers.has(player.userId!);
                // 레벨은 쌓지 않는다. 누적 XP의 함수라서 두 군데 적으면 곡선을 바꾸는 순간 어긋난다.
                // 세는 것은 읽을 때 한다(shared의 levelFromXp).
                const xpGain = matchXp({
                    won,
                    tagCount: player.tagCount,
                    switchSuccess: player.switchSuccess,
                    survivedMs: player.survivedMs,
                });
                await tx.execute(sql`
                    UPDATE ${schema.users}
                    SET stats = stats || jsonb_build_object(
                        'games', COALESCE((stats ->> 'games')::integer, 0) + 1,
                        'wins', COALESCE((stats ->> 'wins')::integer, 0) + ${won ? 1 : 0},
                        'sw_try', COALESCE((stats ->> 'sw_try')::integer, 0) + ${player.switchTry},
                        'sw_su', COALESCE((stats ->> 'sw_su')::integer, 0) + ${player.switchSuccess},
                        'kill', COALESCE((stats ->> 'kill')::integer, 0) + ${player.tagCount},
                        'xp', COALESCE((stats ->> 'xp')::integer, 0) + ${xpGain}
                    ), updated_at = now()
                    WHERE id = ${player.userId!}
                `);
            }
            return 'stored';
        });
    }

    /**
     * 같은 방의 두 번째 경기 결과를 받아 준다. 경기마다 새 matchId가 발급되는데 매칭 서버는 방을 만들 때
     * 한 번만 발급하므로, 재경기의 matchId는 여기 처음 도착한다.
     *
     * 권한은 방으로 판정한다. 방을 배정한 서버가 보낸 결과여야 하고, 참가자는 매칭 서버가 그 방에 들여보낸
     * 사람의 부분집합이어야 한다. 그 두 가지가 맞으면 게임 서버가 자기 방에서 무슨 경기를 몇 번 하는지는
     * 매칭 서버가 관여할 일이 아니다.
     */
    private async issueRematch(
        tx: PostgresJsDatabase<typeof schema>,
        result: MatchResultMessage,
    ): Promise<typeof schema.matches.$inferSelect | null> {
        const [origin] = await tx.select().from(schema.matches)
            .where(and(
                eq(schema.matches.roomId, result.roomId),
                eq(schema.matches.serverId, result.serverId),
            ))
            .orderBy(desc(schema.matches.createdAt))
            .limit(1)
            .for('update');
        if (!origin) return null;

        const assignments = await tx.select().from(schema.matchAssignments)
            .where(eq(schema.matchAssignments.matchId, origin.matchId));
        if (!assignments.length || !this.isAssignedParticipantSubset(result, assignments)) return null;

        const [created] = await tx.insert(schema.matches).values({
            matchId: result.matchId,
            serverId: result.serverId,
            roomId: result.roomId,
            mapId: result.mapId,
        }).returning();
        if (!created) return null;

        // 배정을 옮겨 붙인다. 다음 재경기가 이 행을 원본으로 삼아 같은 판정을 할 수 있어야 한다.
        await tx.insert(schema.matchAssignments).values(assignments.map((assignment) => ({
            matchId: created.matchId,
            actorId: assignment.actorId,
            userId: assignment.userId,
            nickname: assignment.nickname,
            isGuest: assignment.isGuest,
        })));
        return created;
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
