import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import { makeKeys } from 'shared';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';
import { RedisService } from '../redis/redis.service';
import { RoomsService } from '../rooms/rooms.service';
import { retentionSettings, type RetentionSettings } from './retention.settings';

interface ReplayDeletionRow extends Record<string, unknown> {
    replayId: string;
    storageKey: string;
    serverId: string;
}

interface IdRow extends Record<string, unknown> {
    id: string;
}

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RetentionService.name);
    private readonly settings: RetentionSettings = retentionSettings();
    private readonly keys = makeKeys(process.env.APP_ENV ?? 'dev');
    private readonly lockKey = `${process.env.APP_ENV ?? 'dev'}:retention:leader`;
    private firstRunTimer: NodeJS.Timeout | undefined;
    private intervalTimer: NodeJS.Timeout | undefined;
    private destroyed = false;

    constructor(
        @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
        private readonly redis: RedisService,
        private readonly rooms: RoomsService,
    ) {}

    onModuleInit(): void {
        // 여러 인스턴스가 함께 뜨는 배포 직후에는 DB와 Redis가 가장 바쁘므로 첫 회차를 늦춘다.
        this.firstRunTimer = setTimeout(() => {
            if (this.destroyed) return;
            void this.runScheduled();
            this.intervalTimer = setInterval(
                () => void this.runScheduled(),
                this.settings.intervalMinutes * 60_000,
            );
            this.intervalTimer.unref();
        }, 60_000);
        this.firstRunTimer.unref();
    }

    onModuleDestroy(): void {
        this.destroyed = true;
        if (this.firstRunTimer) clearTimeout(this.firstRunTimer);
        if (this.intervalTimer) clearInterval(this.intervalTimer);
    }

    async runOnce(now = new Date()): Promise<void> {
        const lockValue = randomUUID();
        const acquired = await this.redis.setIfAbsent(
            this.lockKey,
            lockValue,
            Math.max(1, Math.floor(this.settings.intervalMinutes * 30)),
        );
        if (!acquired) return;

        try {
            const marked = await this.markExpiredReplays(now);
            const replayResult = await this.deleteReplayFiles();
            const matchesDeleted = await this.deleteExpiredMatches(now);
            if (marked > 0 || replayResult.attempted > 0 || matchesDeleted > 0) {
                this.logger.log(
                    `Retention marked=${marked} replayDeleted=${replayResult.deleted} `
                    + `replayFailed=${replayResult.attempted - replayResult.deleted} matchesDeleted=${matchesDeleted}`,
                );
            }
        } finally {
            await this.redis.compareAndDelete(this.lockKey, lockValue);
        }
    }

    private async runScheduled(): Promise<void> {
        try {
            await this.runOnce();
        } catch (error) {
            this.logger.error('보관 기간 정리 회차 실패', error);
        }
    }

    private async markExpiredReplays(now: Date): Promise<number> {
        const rows = await this.db.execute<IdRow>(sql`
            WITH ranked_user_matches AS MATERIALIZED (
                SELECT participant.user_id,
                       participant.match_id,
                       ROW_NUMBER() OVER (
                           PARTITION BY participant.user_id
                           ORDER BY match.ended_at DESC NULLS LAST, match.match_id DESC
                       ) AS replay_rank
                FROM match_participants participant
                INNER JOIN matches match ON match.match_id = participant.match_id
                WHERE participant.user_id IS NOT NULL
                  AND match.ended_at IS NOT NULL
                  /* 보관 기간 밖의 경기는 어차피 아무도 못 들고 있다. 순위를 매기기 전에 잘라
                     두면 이 창(window)이 전체 경기가 아니라 최근 며칠로 묶인다 — 10분마다 도는
                     작업이라 여기서 안 자르면 경기가 쌓일수록 비용이 같이 는다. 줄 주석(--)을
                     안 쓰는 이유는 한 줄로 눌리는 순간 뒤가 통째로 주석이 되기 때문이다. */
                  AND match.ended_at >= ${now} - ${this.settings.replayDays} * INTERVAL '1 day'
            ), candidates AS (
                SELECT replay.id
                FROM replays replay
                INNER JOIN matches match ON match.match_id = replay.match_id
                WHERE replay.status = 'available'
                  AND NOT EXISTS (
                      SELECT 1
                      FROM replay_holds hold
                      WHERE hold.replay_id = replay.id
                        AND hold.released_at IS NULL
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM ranked_user_matches retained
                      WHERE retained.match_id = replay.match_id
                        AND retained.replay_rank <= ${this.settings.replayPerUserMatches}
                  )
                ORDER BY match.ended_at NULLS FIRST, replay.id
                LIMIT 200
                FOR UPDATE OF replay SKIP LOCKED
            )
            UPDATE replays replay
            SET status = 'deleting'
            FROM candidates candidate
            WHERE replay.id = candidate.id
            RETURNING replay.id
        `);
        return rows.length;
    }

    private async deleteReplayFiles(): Promise<{ attempted: number; deleted: number }> {
        const liveServerIds = await this.redis.sortedSetMembers(this.keys.gameServersAlive(), 0, -1);
        if (liveServerIds.length === 0) return { attempted: 0, deleted: 0 };

        const rows = await this.db.execute<ReplayDeletionRow>(sql`
            SELECT replay.id AS "replayId",
                   replay.storage_key AS "storageKey",
                   match.server_id AS "serverId"
            FROM replays replay
            INNER JOIN matches match ON match.match_id = replay.match_id
            WHERE replay.status = 'deleting'
              AND NOT EXISTS (
                  SELECT 1
                  FROM replay_holds hold
                  WHERE hold.replay_id = replay.id
                    AND hold.released_at IS NULL
              )
            ORDER BY replay.created_at, replay.id
            LIMIT 200
        `);
        const live = new Set(liveServerIds);
        let deleted = 0;
        for (const row of rows) {
            // 로컬 저장소는 같은 기계의 서버들이 디렉터리를 공유하므로 원 서버가 죽었을 때
            // 살아 있는 다른 서버가 지워도 같은 파일을 가리킨다.
            const serverId = live.has(row.serverId) ? row.serverId : liveServerIds[0];
            const succeeded = await this.rooms.requestReplayDeletion(serverId, {
                replayId: row.replayId,
                storageKey: row.storageKey,
            });
            if (!succeeded) continue;

            const removed = await this.db.execute<IdRow>(sql`
                DELETE FROM replays
                WHERE id = ${row.replayId}
                  AND status = 'deleting'
                RETURNING id
            `);
            deleted += removed.length;
        }
        return { attempted: rows.length, deleted };
    }

    private async deleteExpiredMatches(now: Date): Promise<number> {
        const rows = await this.db.execute<IdRow>(sql`
            WITH candidates AS (
                SELECT match.match_id
                FROM matches match
                WHERE match.ended_at < ${now} - ${this.settings.matchDays} * INTERVAL '1 day'
                  AND NOT EXISTS (
                      SELECT 1
                      FROM moderation_cases moderation_case
                      WHERE moderation_case.match_id = match.match_id
                        AND moderation_case.status <> 'CLOSED'
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM replays replay
                      WHERE replay.match_id = match.match_id
                  )
                ORDER BY match.ended_at, match.match_id
                LIMIT 200
                FOR UPDATE OF match SKIP LOCKED
            )
            DELETE FROM matches match
            USING candidates candidate
            WHERE match.match_id = candidate.match_id
            RETURNING match.match_id AS id
        `);
        return rows.length;
    }
}
