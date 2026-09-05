import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
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

export interface AccountStatsDelta {
    userId: number;
    won: boolean;
    games: 1;
    wins: 0 | 1;
    switchTry: number;
    switchSuccess: number;
    tagCount: number;
    survivedMs: number;
    xp: number;
}

/** 게스트를 걸러낸 뒤 한 경기에서 계정 누적치에 더할 값만 만든다. */
export function accountStatsDeltas(result: MatchResultMessage): AccountStatsDelta[] {
    const winningUsers = new Set(winnerUserIds(result));
    return statsEligible(result.players).map((player) => {
        const won = winningUsers.has(player.userId!);
        return {
            userId: player.userId!,
            won,
            games: 1,
            wins: won ? 1 : 0,
            switchTry: player.switchTry,
            switchSuccess: player.switchSuccess,
            tagCount: player.tagCount,
            survivedMs: player.survivedMs,
            xp: matchXp({
                won,
                tagCount: player.tagCount,
                switchSuccess: player.switchSuccess,
                survivedMs: player.survivedMs,
            }),
        };
    });
}

export function linkedParticipantUserId(
    player: MatchResultMessage['players'][number],
    activeUserIds: ReadonlySet<number>,
): number | null {
    return !player.isGuest && player.userId !== null && activeUserIds.has(player.userId)
        ? player.userId
        : null;
}

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
            // matchId는 매칭 서버가 미리 만든 행 자체가 권한표다. 같은 방의 과거 결과는 새 권한이 아니다.
            const match = existing;
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
            const accountIds = result.players.flatMap((player) =>
                !player.isGuest && player.userId !== null ? [player.userId] : []);
            const activeAccounts = accountIds.length === 0
                ? []
                : await tx.select({ id: schema.users.id }).from(schema.users).where(and(
                    inArray(schema.users.id, accountIds),
                    eq(schema.users.accountStatus, 'ACTIVE'),
                )).for('key share');
            const activeUserIds = new Set(activeAccounts.map((account) => account.id));
            await tx.insert(schema.matchParticipants).values(result.players.map((player) => ({
                matchId: result.matchId,
                // 탈퇴와 결과 도착이 맞물려도 지운 계정으로 전적 연결을 되살리지 않는다.
                userId: linkedParticipantUserId(player, activeUserIds),
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

            for (const delta of accountStatsDeltas(result)) {
                // 레벨은 쌓지 않는다. 누적 XP의 함수라서 두 군데 적으면 곡선을 바꾸는 순간 어긋난다.
                // 세는 것은 읽을 때 한다(shared의 levelFromXp).
                await tx.execute(sql`
                    UPDATE ${schema.users}
                    SET stats = stats || jsonb_build_object(
                        'games', COALESCE((stats ->> 'games')::integer, 0) + ${delta.games},
                        'wins', COALESCE((stats ->> 'wins')::integer, 0) + ${delta.wins},
                        'sw_try', COALESCE((stats ->> 'sw_try')::integer, 0) + ${delta.switchTry},
                        'sw_su', COALESCE((stats ->> 'sw_su')::integer, 0) + ${delta.switchSuccess},
                        'kill', COALESCE((stats ->> 'kill')::integer, 0) + ${delta.tagCount},
                        'survived_ms', COALESCE((stats ->> 'survived_ms')::bigint, 0) + ${delta.survivedMs},
                        'survived_games', COALESCE((stats ->> 'survived_games')::integer, 0) + 1,
                        'xp', COALESCE((stats ->> 'xp')::integer, 0) + ${delta.xp}
                    ), updated_at = now()
                    WHERE id = ${delta.userId}
                      AND account_status = 'ACTIVE'
                `);
            }
            return 'stored';
        });
    }

    /**
     * 방금 끝난 경기의 **다음** 경기를 미리 발급한다.
     *
     * 예전에는 인게임 서버가 두 번째 경기부터 id를 스스로 만들었고, 매칭 서버는 모르는 id가 와도
     * 같은 방의 과거 경기를 근거로 행을 만들어 줬다. 그 경로가 있으면 침해된 인게임 서버가 새
     * UUID로 전적과 XP를 무한히 적립할 수 있다. 그래서 만드는 쪽을 여기로 옮겼다.
     *
     * 배정은 방금 끝난 경기에서 그대로 옮겨 붙인다. 이 방에 매칭 서버가 들여보낸 사람이 누구인지는
     * 그 목록이 답이고, 다음 경기의 참가자 검사도 같은 목록을 본다.
     *
     * 발급된 id가 안 쓰이고 남을 수 있다 — 사람들이 그냥 나가면 그렇다. 결과가 없는 행이라
     * 전적에도 통계에도 잡히지 않고, 보관 정리가 걷어 간다.
     */
    async issueNextMatch(finished: MatchResultMessage): Promise<string | null> {
        return this.db.transaction(async (tx) => {
            const assignments = await tx.select().from(schema.matchAssignments)
                .where(eq(schema.matchAssignments.matchId, finished.matchId));
            if (!assignments.length) return null;

            const matchId = randomUUID();
            const [created] = await tx.insert(schema.matches).values({
                matchId,
                serverId: finished.serverId,
                roomId: finished.roomId,
                mapId: finished.mapId,
            }).returning({ matchId: schema.matches.matchId });
            if (!created) return null;

            await tx.insert(schema.matchAssignments).values(assignments.map((assignment) => ({
                matchId,
                actorId: assignment.actorId,
                userId: assignment.userId,
                nickname: assignment.nickname,
                isGuest: assignment.isGuest,
            })));
            return matchId;
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
