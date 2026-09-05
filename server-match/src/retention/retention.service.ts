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

/**
 * 기준 시각에서 며칠 전.
 *
 * SQL 안에서 `$1 - $2 * INTERVAL '1 day'`처럼 계산하지 않는다. 그러면 Postgres가 $1의 타입을
 * 정하지 못해 드라이버가 Date를 실어 보내다 죽는다(ERR_INVALID_ARG_TYPE) — 그리고 정리 작업은
 * 그 예외를 삼키고 조용히 아무것도 안 지운다. 자를 시각을 여기서 정해 값 하나로 넘긴다.
 */
/** 한 회차에 파일을 지워 볼 최대 건수. 나머지는 다음 회차로 미룬다. */
const DELETE_BATCH = 40;
/** 이만큼 연속으로 실패하면 이번 회차는 접는다. 실패는 대개 한 건이 아니라 상태다. */
const MAX_CONSECUTIVE_DELETE_FAILURES = 3;

function daysAgo(now: Date, days: number): string {
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function hoursAgo(now: Date, hours: number): string {
    return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
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
            const sessionsDeleted = await this.deleteExpiredSessions(now);
            const auditIpsScrubbed = await this.scrubExpiredAuditIps(now);
            const auditLogsDeleted = await this.deleteExpiredAuditLogs(now);
            const sanctionHmacsDeleted = await this.deleteExpiredSanctionEmailHmacs(now);
            if (marked > 0 || replayResult.attempted > 0 || matchesDeleted > 0 || sessionsDeleted > 0
                || auditIpsScrubbed > 0 || auditLogsDeleted > 0 || sanctionHmacsDeleted > 0) {
                this.logger.log(
                    `Retention marked=${marked} replayDeleted=${replayResult.deleted} `
                    + `replayFailed=${replayResult.attempted - replayResult.deleted} matchesDeleted=${matchesDeleted} `
                    + `sessionsDeleted=${sessionsDeleted} auditIpsScrubbed=${auditIpsScrubbed} `
                    + `auditLogsDeleted=${auditLogsDeleted} sanctionHmacsDeleted=${sanctionHmacsDeleted}`,
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
            WITH candidates AS (
                SELECT replay.id
                FROM replays replay
                INNER JOIN matches match ON match.match_id = replay.match_id
                WHERE replay.status = 'available'
                  AND match.ended_at < ${hoursAgo(now, this.settings.replayHours)}::timestamptz
                  AND NOT EXISTS (
                      SELECT 1
                      FROM replay_holds hold
                      WHERE hold.replay_id = replay.id
                        AND hold.released_at IS NULL
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
            LIMIT ${DELETE_BATCH}
        `);
        const live = new Set(liveServerIds);
        let deleted = 0;
        let consecutiveFailures = 0;
        for (const row of rows) {
            /*
             * 몇 번 연속으로 실패하면 이 회차는 접는다.
             *
             * 실패는 대개 한 건짜리 사고가 아니라 상태다 — 인게임 서버에 리플레이 저장소가 없거나
             * 제어 평면이 막혔거나. 그때 남은 행을 계속 두드리면 요청 하나마다 명령 시한을 꽉
             * 채워 기다리고, 그 시간 동안 **방 생성 같은 진짜 명령이 같은 줄에 선다.** 지우는
             * 일은 급하지 않다. 다음 회차에 다시 온다.
             */
            if (consecutiveFailures >= MAX_CONSECUTIVE_DELETE_FAILURES) {
                this.logger.warn(
                    `리플레이 삭제가 ${consecutiveFailures}번 연속 실패해 이번 회차를 멈춘다`
                    + ` (남은 ${rows.length - deleted}건은 다음 회차로).`,
                );
                break;
            }
            // 로컬 저장소는 같은 기계의 서버들이 디렉터리를 공유하므로 원 서버가 죽었을 때
            // 살아 있는 다른 서버가 지워도 같은 파일을 가리킨다.
            const serverId = live.has(row.serverId) ? row.serverId : liveServerIds[0];
            const succeeded = await this.rooms.requestReplayDeletion(serverId, {
                replayId: row.replayId,
                storageKey: row.storageKey,
            });
            if (!succeeded) {
                consecutiveFailures += 1;
                continue;
            }
            consecutiveFailures = 0;

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

    /**
     * 끝난 세션 행을 지운다.
     *
     * 세션은 밴과 탈퇴에서만 지워졌다. 그 밖에는 만료돼도, 폐기돼도 행이 남았고 refresh는
     * 회전할 때마다 새 행을 만든다. 인증 경로가 매번 읽는 테이블이라 그대로 두면 로그인이
     * 시간에 비례해 느려진다.
     *
     * 살아 있는 세션은 건드리지 않는다 - 조건이 "만료됐거나 폐기됐고, 그러고도 보관 기간이
     * 지났다"이다.
     */
    private async deleteExpiredSessions(now: Date): Promise<number> {
        const rows = await this.db.execute<IdRow>(sql`
            WITH candidates AS (
                SELECT session.id
                FROM sessions session
                WHERE (session.revoked_at IS NOT NULL OR session.expires_at < ${now}::timestamptz)
                  AND COALESCE(session.revoked_at, session.expires_at)
                      < ${daysAgo(now, this.settings.sessionDays)}::timestamptz
                ORDER BY session.id
                LIMIT 500
                FOR UPDATE OF session SKIP LOCKED
            )
            DELETE FROM sessions session
            USING candidates candidate
            WHERE session.id = candidate.id
            RETURNING session.id
        `);
        return rows.length;
    }

    private async deleteExpiredMatches(now: Date): Promise<number> {
        const rows = await this.db.execute<IdRow>(sql`
            WITH candidates AS (
                SELECT match.match_id
                FROM matches match
                WHERE match.ended_at < ${daysAgo(now, this.settings.matchDays)}::timestamptz
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

    /** 감사 본문은 남겨도 암호화 IP 원본은 단기 조사 기간이 끝나면 먼저 비운다. */
    private async scrubExpiredAuditIps(now: Date): Promise<number> {
        const rows = await this.db.execute<IdRow>(sql`
            WITH retention_mode AS (
                SELECT set_config('switch.audit_retention', 'on', true)
            ), candidates AS (
                SELECT audit.id
                FROM admin_audit_log audit, retention_mode
                WHERE audit.ip_encrypted IS NOT NULL
                  AND audit.created_at < ${daysAgo(now, this.settings.auditIpDays)}::timestamptz
                ORDER BY audit.created_at, audit.id
                LIMIT 500
                FOR UPDATE OF audit SKIP LOCKED
            )
            UPDATE admin_audit_log audit
            SET ip_encrypted = NULL
            FROM candidates candidate
            WHERE audit.id = candidate.id
            RETURNING audit.id
        `);
        return rows.length;
    }

    private async deleteExpiredAuditLogs(now: Date): Promise<number> {
        const rows = await this.db.execute<IdRow>(sql`
            WITH retention_mode AS (
                SELECT set_config('switch.audit_retention', 'on', true)
            ), candidates AS (
                SELECT audit.id
                FROM admin_audit_log audit, retention_mode
                WHERE audit.created_at < ${daysAgo(now, this.settings.auditLogDays)}::timestamptz
                ORDER BY audit.created_at, audit.id
                LIMIT 500
                FOR UPDATE OF audit SKIP LOCKED
            )
            DELETE FROM admin_audit_log audit
            USING candidates candidate
            WHERE audit.id = candidate.id
            RETURNING audit.id
        `);
        return rows.length;
    }

    /** 기간제·취소 제재의 목적이 끝나면 재가입 대조값도 함께 없앤다. 영구 BAN만 남는다. */
    private async deleteExpiredSanctionEmailHmacs(now: Date): Promise<number> {
        const rows = await this.db.execute<IdRow>(sql`
            WITH candidates AS (
                SELECT sanction.id
                FROM sanctions sanction
                WHERE sanction.email_hmac IS NOT NULL
                  AND (
                      sanction.expires_at <= ${now}::timestamptz
                      OR (sanction.expires_at IS NULL AND sanction.type <> 'BAN')
                      OR EXISTS (
                          SELECT 1 FROM sanction_revocations revocation
                          WHERE revocation.sanction_id = sanction.id
                      )
                  )
                ORDER BY sanction.created_at, sanction.id
                LIMIT 500
                FOR UPDATE OF sanction SKIP LOCKED
            )
            UPDATE sanctions sanction
            SET email_hmac = NULL
            FROM candidates candidate
            WHERE sanction.id = candidate.id
            RETURNING sanction.id
        `);
        return rows.length;
    }
}
