import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';

const MAX_AUDIT_PAGE = 50;

interface PlayerRow {
    [key: string]: unknown;
    userId: number;
    nickname: string;
    accountStatus: string;
    role: string;
    createdAt: Date;
    activeSessions: number;
    reportsAgainst: number;
    reportsFiled: number;
    recentMatches: number;
}

interface SanctionRow {
    [key: string]: unknown;
    id: string;
    type: string;
    scope: string;
    startsAt: Date;
    expiresAt: Date | null;
    reason: string;
    createdBy: string;
    revokedAt: Date | null;
}

interface AuditRow {
    [key: string]: unknown;
    id: number;
    actor: string;
    action: string;
    targetType: string;
    targetId: string;
    reason: string;
    createdAt: Date;
}

/**
 * 플레이어 조회와 감사 로그 열람.
 *
 * **IP는 여기서 나오지 않는다.** `FUTURE.md` §3.3은 원본 IP 열람에 `security` 권한과 열람 사유,
 * 그리고 감사 기록을 요구한다. 지금 역할은 USER/ADMIN 둘뿐이라 그 통제를 만들 수가 없다.
 * 만들 수 없는 통제를 흉내 내느니 값을 안 내보내는 쪽이 맞다 — 화면에 한 번 뜨기 시작하면
 * 그 뒤로 빼기가 훨씬 어렵다.
 *
 * 조회 자체는 감사 로그에 남긴다. 남의 계정을 들여다보는 일이고, 누가 언제 봤는지 남지 않으면
 * 그 화면은 통제가 아니라 그냥 권한이다.
 */
@Injectable()
export class PlayerLookupService {
    constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>) {}

    async lookup(actorUserId: number, query: string) {
        const asId = /^\d+$/.test(query) ? Number(query) : null;
        const [player] = await this.db.execute<PlayerRow>(sql`
            SELECT account.id AS "userId",
                   account.nickname,
                   account.account_status::text AS "accountStatus",
                   account.role::text AS "role",
                   account.created_at AS "createdAt",
                   (
                       SELECT count(*)::integer FROM sessions
                       WHERE sessions.user_id = account.id AND sessions.revoked_at IS NULL
                   ) AS "activeSessions",
                   (
                       SELECT count(*)::integer FROM moderation_cases
                       WHERE moderation_cases.target_user_id = account.id
                   ) AS "reportsAgainst",
                   (
                       SELECT count(*)::integer FROM reports
                       WHERE reports.reporter_user_id = account.id
                   ) AS "reportsFiled",
                   (
                       SELECT count(*)::integer FROM match_participants
                       WHERE match_participants.user_id = account.id
                   ) AS "recentMatches"
            FROM users account
            WHERE ${asId === null ? sql`account.nickname = ${query}` : sql`account.id = ${asId}`}
            LIMIT 1
        `);
        if (!player) throw new NotFoundException({ code: 'PLAYER_NOT_FOUND', message: 'No such player' });

        const sanctions = await this.db.execute<SanctionRow>(sql`
            SELECT sanction.id,
                   sanction.type::text AS "type",
                   sanction.scope,
                   sanction.starts_at AS "startsAt",
                   sanction.expires_at AS "expiresAt",
                   sanction.reason,
                   sanction.created_by AS "createdBy",
                   revocation.created_at AS "revokedAt"
            FROM sanctions sanction
            LEFT JOIN sanction_revocations revocation ON revocation.sanction_id = sanction.id
            WHERE sanction.user_id = ${player.userId}
            ORDER BY sanction.created_at DESC
            LIMIT 20
        `);

        await this.db.insert(schema.adminAuditLog).values({
            actor: `admin:${actorUserId}`,
            action: 'player.lookup',
            targetType: 'user',
            targetId: String(player.userId),
            reason: '플레이어 조회',
            requestMeta: { query },
        });

        return {
            player: {
                userId: player.userId,
                nickname: player.nickname,
                accountStatus: player.accountStatus,
                role: player.role,
                createdAt: player.createdAt.toISOString(),
                activeSessions: player.activeSessions,
                reportsAgainst: player.reportsAgainst,
                reportsFiled: player.reportsFiled,
                matchesPlayed: player.recentMatches,
            },
            sanctions: sanctions.map((row) => ({
                id: row.id,
                type: row.type,
                scope: row.scope,
                startsAt: row.startsAt.toISOString(),
                expiresAt: row.expiresAt?.toISOString() ?? null,
                reason: row.reason,
                createdBy: row.createdBy,
                revokedAt: row.revokedAt?.toISOString() ?? null,
            })),
        };
    }

    /** 감사 로그는 append-only다. 커서는 id 하나면 된다 — 시각이 같아도 순서가 흔들리지 않는다. */
    async auditLog(limit: number, before?: number) {
        const size = Math.min(MAX_AUDIT_PAGE, Math.max(1, limit));
        // 커서는 화면이 준 값이라 숫자가 아닐 수 있다. NaN을 그대로 넘기면 쿼리가 터진다.
        const cursor = Number.isSafeInteger(before) ? before : undefined;
        const rows = await this.db.execute<AuditRow>(sql`
            SELECT id, actor, action, target_type AS "targetType", target_id AS "targetId",
                   reason, created_at AS "createdAt"
            FROM admin_audit_log
            ${cursor === undefined ? sql`` : sql`WHERE id < ${cursor}`}
            ORDER BY id DESC
            LIMIT ${size + 1}
        `);
        const hasMore = rows.length > size;
        const page = rows.slice(0, size);
        return {
            items: page.map((row) => ({
                id: row.id,
                actor: row.actor,
                action: row.action,
                target: `${row.targetType}:${row.targetId}`,
                reason: row.reason,
                createdAt: row.createdAt.toISOString(),
            })),
            nextBefore: hasMore ? page.at(-1)?.id ?? null : null,
        };
    }
}
