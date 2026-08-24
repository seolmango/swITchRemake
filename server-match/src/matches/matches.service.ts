import { ForbiddenException, Inject, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ActorId } from 'shared';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';

export interface MatchPlayerResult {
    playerId: string;
    slot: number;
    nickname: string;
    tagCount: number;
    taggedCount: number;
    switchSuccess: number;
    switchTry: number;
    survivedMs: number;
    isSelf: boolean;
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
        };
    }
}
