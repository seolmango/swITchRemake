import { ForbiddenException, Inject, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { levelFromXp, matchXpBreakdown, type ActorId, type MatchXpBreakdown } from 'shared';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';
import { nonNegativeInteger, readStoredStats } from '../user/stored-stats';

export interface MatchPlayerResult {
    playerId: string;
    isGuest: boolean;
    slot: number;
    nickname: string;
    tagCount: number;
    taggedCount: number;
    switchSuccess: number;
    switchTry: number;
    survivedMs: number;
    isSelf: boolean;
}

/**
 * 이 경기로 요청자가 받은 XP. 게스트에게는 null이다 — 쌓아 둘 계정이 없다.
 *
 * 값을 따로 저장하지 않고 참가 기록에서 다시 센다. 레벨을 저장하지 않는 것과 같은 이유다 —
 * 두 군데 적어 두면 곡선을 고치는 순간 어긋나고, 어느 쪽이 맞는지 아무도 모르게 된다.
 */
export interface MatchRewardSummary {
    breakdown: MatchXpBreakdown;
    /** 지금 시점의 레벨과 진행도. 이 경기 직후가 아니라 **읽는 시점** 기준이다. */
    level: number;
    xpIntoLevel: number;
    xpForNextLevel: number;
}

/** Matches client/src/api/matches.ts's MatchResultSnapshot exactly. */
export interface MatchResultSnapshot {
    matchId: string;
    roomId: string;
    map: string;
    durationMs: number;
    playedAt: string;
    winners: [string, string];
    players: MatchPlayerResult[];
    reward: MatchRewardSummary | null;
}

export interface PendingMatchResult {
    status: 'pending';
    retryAfterMs: number;
}

export type MatchResultResponse = MatchResultSnapshot | PendingMatchResult;

@Injectable()
export class MatchesService {
    constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>) {}

    async getResult(matchId: string, actorId: ActorId): Promise<MatchResultResponse> {
        const rows = await this.db.select({
            matchId: schema.matches.matchId,
            roomId: schema.matches.roomId,
            mapId: schema.matches.mapId,
            startedAt: schema.matches.startedAt,
            endedAt: schema.matches.endedAt,
            resultRecordedAt: schema.matches.resultRecordedAt,
            playerId: schema.matchParticipants.playerId,
            userId: schema.matchParticipants.userId,
            nickname: schema.matchParticipants.nickname,
            isGuest: schema.matchParticipants.isGuest,
            isWinner: schema.matchParticipants.isWinner,
            tagCount: schema.matchParticipants.tagCount,
            taggedCount: schema.matchParticipants.taggedCount,
            switchSuccess: schema.matchParticipants.switchSuccess,
            switchTry: schema.matchParticipants.switchTry,
            survivedMs: schema.matchParticipants.survivedMs,
        }).from(schema.matches)
            .leftJoin(schema.matchParticipants, eq(schema.matchParticipants.matchId, schema.matches.matchId))
            .where(eq(schema.matches.matchId, matchId))
            .orderBy(asc(schema.matchParticipants.playerId));
        const match = rows[0];
        if (!match) throw new NotFoundException({ code: 'MATCH_NOT_FOUND', message: 'Match not found' });

        // match_assignments stores the authenticated actor id at seat assignment. Unlike user_id,
        // it is present for both accounts and guests, so a guest result cannot be claimed by name.
        const [assignment] = await this.db.select({
            nickname: schema.matchAssignments.nickname,
            isGuest: schema.matchAssignments.isGuest,
        }).from(schema.matchAssignments)
            .where(and(
                eq(schema.matchAssignments.matchId, matchId),
                eq(schema.matchAssignments.actorId, String(actorId)),
            ))
            .limit(1);
        if (!assignment) throw new ForbiddenException({ code: 'MATCH_RESULT_FORBIDDEN', message: 'Not a match participant' });

        if (!match.resultRecordedAt) return { status: 'pending', retryAfterMs: 500 };
        if (!match.roomId || !match.startedAt || !match.endedAt) {
            throw new InternalServerErrorException({ code: 'MATCH_RESULT_INCOMPLETE', message: 'Recorded match is incomplete' });
        }

        const players = rows.flatMap((row) => {
            if (row.playerId === null || row.nickname === null || row.isGuest === null || row.isWinner === null
                || row.tagCount === null || row.taggedCount === null || row.switchSuccess === null
                || row.switchTry === null || row.survivedMs === null) return [];
            return [{
                playerId: String(row.playerId),
                slot: row.playerId,
                nickname: row.nickname,
                tagCount: row.tagCount,
                taggedCount: row.taggedCount,
                switchSuccess: row.switchSuccess,
                switchTry: row.switchTry,
                survivedMs: row.survivedMs,
                // 신고 화면이 "게스트는 제재를 걸 수 없다"를 정직하게 말하려면 필요하다.
                // 계정 id는 싣지 않는다 — 화면이 알 필요가 없고, 알면 경기 밖으로 새 나간다.
                isGuest: row.isGuest,
                isSelf: row.userId !== null
                    ? row.userId === actorId
                    : assignment.isGuest && row.nickname === assignment.nickname,
                isWinner: row.isWinner,
            }];
        });
        const winnerIds = players.filter((player) => player.isWinner).map((player) => player.playerId);
        if (winnerIds.length === 0) {
            throw new InternalServerErrorException({ code: 'MATCH_RESULT_INCOMPLETE', message: 'Recorded match has no winner' });
        }

        return {
            matchId: match.matchId,
            roomId: match.roomId,
            map: match.mapId,
            durationMs: Math.max(0, match.endedAt.getTime() - match.startedAt.getTime()),
            playedAt: match.endedAt.toISOString(),
            winners: [winnerIds[0]!, winnerIds[1] ?? winnerIds[0]!],
            players: players.map(({ isWinner: _isWinner, ...player }) => player),
            reward: await this.rewardFor(actorId, rows),
        };
    }

    /**
     * 요청자가 계정이면 이 경기의 XP 내역과 지금 레벨을 만든다.
     *
     * 게스트는 null이다. `match_participants.user_id`로만 찾는 이유는 그 컬럼이 곧 XP가 실제로
     * 들어간 계정이기 때문이다 — 닉네임으로 찾으면 게스트가 남의 보상 화면을 볼 수 있다.
     */
    private async rewardFor(
        actorId: ActorId,
        rows: Array<{
            userId: number | null;
            isWinner: boolean | null;
            tagCount: number | null;
            switchSuccess: number | null;
            survivedMs: number | null;
        }>,
    ): Promise<MatchRewardSummary | null> {
        if (typeof actorId !== 'number') return null;
        const self = rows.find((row) => row.userId === actorId);
        if (!self || self.isWinner === null || self.tagCount === null
            || self.switchSuccess === null || self.survivedMs === null) return null;

        const [account] = await this.db.select({ stats: schema.users.stats })
            .from(schema.users)
            .where(eq(schema.users.id, actorId))
            .limit(1);
        const xp = nonNegativeInteger(readStoredStats(account?.stats).xp);
        const progress = levelFromXp(xp);
        return {
            breakdown: matchXpBreakdown({
                won: self.isWinner,
                tagCount: self.tagCount,
                switchSuccess: self.switchSuccess,
                survivedMs: self.survivedMs,
            }),
            level: progress.level,
            xpIntoLevel: progress.xpIntoLevel,
            xpForNextLevel: progress.xpForNextLevel,
        };
    }
}
