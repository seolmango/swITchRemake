import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { alias } from 'drizzle-orm/pg-core';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';
import { CreateReportDto, type ReportCategory } from './dto/create-report.dto';
import { type ReportStatus } from './dto/report-queue-query.dto';
import { UpdateReportStatusDto } from './dto/update-report-status.dto';

/** 리플레이가 이 상태들 중 하나면 아직 증거가 남아 있다. `deleting`/`deleted`는 이미 늦었다. */
const LIVE_REPLAY_STATUSES = new Set(['recording', 'finalizing', 'available']);
const DEFAULT_QUEUE_STATUSES: ReportStatus[] = ['OPEN', 'TRIAGED', 'REVIEWING'];
const MAX_QUEUE_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALLOWED_TRANSITIONS: Readonly<Record<ReportStatus, readonly ReportStatus[]>> = {
    OPEN: ['TRIAGED', 'DISMISSED'],
    TRIAGED: ['REVIEWING', 'DISMISSED'],
    REVIEWING: ['ACTIONED', 'DISMISSED'],
    ACTIONED: ['CLOSED'],
    DISMISSED: ['CLOSED'],
    CLOSED: [],
};

interface QueueCursor {
    reportCount: number;
    updatedAt: string;
    caseId: string;
}

interface ReportContextRow {
    [key: string]: unknown;
    endedAt: Date | string | null;
    reporterParticipates: boolean;
    targetUserId: number | null;
    targetIsGuest: boolean | null;
    replayStatus: string | null;
}

interface CaseStatusRow {
    [key: string]: unknown;
    caseId: string;
    status: ReportStatus;
}

@Injectable()
export class ReportsService {
    constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>) {}

    async create(reporterUserId: number, dto: CreateReportDto): Promise<CaseStatusRow> {
        try {
            return await this.db.transaction(async (tx) => {
                const [context] = await tx.execute<ReportContextRow>(sql`
                    SELECT m.ended_at AS "endedAt",
                           EXISTS (
                               SELECT 1 FROM match_participants reporter
                               WHERE reporter.match_id = m.match_id
                                 AND reporter.user_id = ${reporterUserId}
                           ) AS "reporterParticipates",
                           target.user_id AS "targetUserId",
                           target.is_guest AS "targetIsGuest",
                           (
                               SELECT replay.status FROM replays replay
                               WHERE replay.match_id = m.match_id
                           ) AS "replayStatus"
                    FROM matches m
                    LEFT JOIN LATERAL (
                        SELECT participant.user_id, participant.is_guest
                        FROM match_participants participant
                        WHERE participant.match_id = m.match_id
                          AND (
                              participant.user_id = ${dto.targetUserId}
                              OR (participant.is_guest AND participant.player_id = ${dto.targetUserId})
                          )
                        ORDER BY (participant.user_id IS NOT NULL) DESC
                        LIMIT 1
                    ) target ON true
                    WHERE m.match_id = ${dto.matchId}
                `);

                if (!context?.reporterParticipates) {
                    throw new ForbiddenException({
                        code: 'REPORTER_NOT_MATCH_PARTICIPANT',
                        message: 'The reporter did not participate in this match',
                    });
                }
                // 게스트는 계정 ID가 없어 제재를 연결할 곳이 없으므로 신고 대상이 될 수 없다.
                if (context.targetUserId === null || context.targetIsGuest) {
                    throw new BadRequestException({
                        code: 'INVALID_REPORT_TARGET',
                        message: 'The target must be an account participant in this match',
                    });
                }
                if (context.targetUserId === reporterUserId) {
                    throw new BadRequestException({
                        code: 'SELF_REPORT',
                        message: 'A participant cannot report themselves',
                    });
                }
                /*
                 * 신고 창은 날짜가 아니라 리플레이 수명에 맞춘다. 증거가 사라진 뒤에 접수만
                 * 받아 두면 조사할 수 없고, 사용자에게는 받아만 놓는 창구가 된다. 보관 정책이
                 * 바뀌면 신고 창도 따라 움직여야 하는데, 날짜를 따로 적어 두면 그 순간 갈라진다.
                 *
                 * 진행 중인 경기는 예외다 — 리플레이 행은 경기가 끝나야 생긴다.
                 */
                if (context.endedAt !== null && !LIVE_REPLAY_STATUSES.has(context.replayStatus ?? '')) {
                    throw new BadRequestException({
                        code: 'REPLAY_UNAVAILABLE',
                        message: 'The replay for this match is no longer retained',
                    });
                }

                const [moderationCase] = await tx.execute<CaseStatusRow>(sql`
                    INSERT INTO moderation_cases (match_id, target_user_id, status)
                    VALUES (${dto.matchId}, ${dto.targetUserId}, 'OPEN')
                    ON CONFLICT (match_id, target_user_id) DO UPDATE
                    SET target_user_id = EXCLUDED.target_user_id
                    RETURNING id AS "caseId", status
                `);
                if (!moderationCase) throw new Error('Failed to create moderation case');

                await tx.execute(sql`
                    INSERT INTO reports (case_id, reporter_user_id, category, tick, description)
                    VALUES (
                        ${moderationCase.caseId},
                        ${reporterUserId},
                        ${dto.category},
                        ${dto.tick ?? null},
                        ${dto.description}
                    )
                `);

                const [updated] = await tx.execute<CaseStatusRow>(sql`
                    UPDATE moderation_cases moderation_case
                    SET report_count = (
                            SELECT count(*)::integer FROM reports report
                            WHERE report.case_id = moderation_case.id
                        ),
                        updated_at = now()
                    WHERE moderation_case.id = ${moderationCase.caseId}
                    RETURNING moderation_case.id AS "caseId", moderation_case.status
                `);

                await tx.execute(sql`
                    INSERT INTO replay_holds (replay_id, case_id, reason)
                    SELECT replay.id, ${moderationCase.caseId}, '신고 사건 증거 보존'
                    FROM replays replay
                    WHERE replay.match_id = ${dto.matchId}
                    ON CONFLICT (replay_id, case_id) DO NOTHING
                `);
                return updated ?? moderationCase;
            });
        } catch (error) {
            if (isDuplicateReport(error)) {
                throw new ConflictException({
                    code: 'DUPLICATE_REPORT',
                    message: 'This reporter already reported this case',
                });
            }
            throw error;
        }
    }

    async getQueue(status: ReportStatus | undefined, requestedLimit = 20, encodedCursor?: string) {
        const limit = Math.min(MAX_QUEUE_LIMIT, Math.max(1, requestedLimit));
        const statuses = status ? [status] : DEFAULT_QUEUE_STATUSES;
        const cursor = encodedCursor ? decodeCursor(encodedCursor) : null;
        const cursorCondition = cursor
            ? or(
                lt(schema.moderationCases.reportCount, cursor.reportCount),
                and(
                    eq(schema.moderationCases.reportCount, cursor.reportCount),
                    lt(schema.moderationCases.updatedAt, new Date(cursor.updatedAt)),
                ),
                and(
                    eq(schema.moderationCases.reportCount, cursor.reportCount),
                    eq(schema.moderationCases.updatedAt, new Date(cursor.updatedAt)),
                    lt(schema.moderationCases.id, cursor.caseId),
                ),
            )
            : undefined;

        const target = alias(schema.users, 'report_target');
        const rows = await this.db.select({
            caseId: schema.moderationCases.id,
            matchId: schema.moderationCases.matchId,
            targetUserId: schema.moderationCases.targetUserId,
            targetNickname: target.nickname,
            status: schema.moderationCases.status,
            reportCount: schema.moderationCases.reportCount,
            updatedAt: schema.moderationCases.updatedAt,
            assignee: schema.moderationCases.assignee,
            latestReportedAt: sql<Date>`max(${schema.reports.createdAt})`,
            cheatCount: sql<number>`count(*) filter (where ${schema.reports.category} = 'CHEAT')`,
            abuseCount: sql<number>`count(*) filter (where ${schema.reports.category} = 'ABUSE')`,
            griefingCount: sql<number>`count(*) filter (where ${schema.reports.category} = 'GRIEFING')`,
            nicknameCount: sql<number>`count(*) filter (where ${schema.reports.category} = 'NICKNAME')`,
        }).from(schema.moderationCases)
            .innerJoin(target, eq(target.id, schema.moderationCases.targetUserId))
            .innerJoin(schema.reports, eq(schema.reports.caseId, schema.moderationCases.id))
            .where(and(inArray(schema.moderationCases.status, statuses), cursorCondition))
            .groupBy(
                schema.moderationCases.id,
                schema.moderationCases.matchId,
                schema.moderationCases.targetUserId,
                target.nickname,
                schema.moderationCases.status,
                schema.moderationCases.reportCount,
                schema.moderationCases.updatedAt,
                schema.moderationCases.assignee,
            )
            .orderBy(
                desc(schema.moderationCases.reportCount),
                desc(schema.moderationCases.updatedAt),
                desc(schema.moderationCases.id),
            )
            .limit(limit + 1);

        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const items = page.map((row) => ({
            caseId: row.caseId,
            matchId: row.matchId,
            target: { userId: row.targetUserId, nickname: row.targetNickname },
            status: row.status,
            reportCount: row.reportCount,
            categories: {
                CHEAT: count(row.cheatCount),
                ABUSE: count(row.abuseCount),
                GRIEFING: count(row.griefingCount),
                NICKNAME: count(row.nicknameCount),
            } satisfies Record<ReportCategory, number>,
            latestReportedAt: toIso(row.latestReportedAt),
            assignee: row.assignee,
        }));
        const last = hasMore ? page.at(-1) : undefined;
        return {
            items,
            nextCursor: last ? encodeCursor({
                reportCount: last.reportCount,
                updatedAt: last.updatedAt.toISOString(),
                caseId: last.caseId,
            }) : null,
        };
    }

    async getCase(caseId: string) {
        const target = alias(schema.users, 'report_target');
        const [moderationCase] = await this.db.select({
            caseId: schema.moderationCases.id,
            matchId: schema.moderationCases.matchId,
            targetUserId: schema.moderationCases.targetUserId,
            targetNickname: target.nickname,
            status: schema.moderationCases.status,
            reportCount: schema.moderationCases.reportCount,
            assignee: schema.moderationCases.assignee,
            note: schema.moderationCases.note,
            createdAt: schema.moderationCases.createdAt,
            updatedAt: schema.moderationCases.updatedAt,
            mapId: schema.matches.mapId,
            endedAt: schema.matches.endedAt,
            replayId: schema.replays.id,
            holdId: schema.replayHolds.id,
        }).from(schema.moderationCases)
            .innerJoin(target, eq(target.id, schema.moderationCases.targetUserId))
            .innerJoin(schema.matches, eq(schema.matches.matchId, schema.moderationCases.matchId))
            .leftJoin(schema.replays, eq(schema.replays.matchId, schema.moderationCases.matchId))
            .leftJoin(schema.replayHolds, and(
                eq(schema.replayHolds.replayId, schema.replays.id),
                eq(schema.replayHolds.caseId, schema.moderationCases.id),
                isNull(schema.replayHolds.releasedAt),
            ))
            .where(eq(schema.moderationCases.id, caseId))
            .limit(1);
        if (!moderationCase) {
            throw new NotFoundException({ code: 'REPORT_CASE_NOT_FOUND', message: 'Moderation case not found' });
        }

        const reporter = alias(schema.users, 'reporter');
        const reports = await this.db.select({
            reporterUserId: schema.reports.reporterUserId,
            reporterNickname: reporter.nickname,
            category: schema.reports.category,
            tick: schema.reports.tick,
            description: schema.reports.description,
            createdAt: schema.reports.createdAt,
        }).from(schema.reports)
            .innerJoin(reporter, eq(reporter.id, schema.reports.reporterUserId))
            .where(eq(schema.reports.caseId, caseId))
            .orderBy(asc(schema.reports.createdAt), asc(schema.reports.id));

        return {
            caseId: moderationCase.caseId,
            matchId: moderationCase.matchId,
            target: { userId: moderationCase.targetUserId, nickname: moderationCase.targetNickname },
            status: moderationCase.status,
            reportCount: moderationCase.reportCount,
            assignee: moderationCase.assignee,
            note: moderationCase.note,
            createdAt: moderationCase.createdAt.toISOString(),
            updatedAt: moderationCase.updatedAt.toISOString(),
            match: {
                mapId: moderationCase.mapId,
                endedAt: moderationCase.endedAt?.toISOString() ?? null,
            },
            replay: moderationCase.replayId === null
                ? null
                : { replayId: moderationCase.replayId, held: moderationCase.holdId !== null },
            reports: reports.map((report) => ({
                reporter: { userId: report.reporterUserId, nickname: report.reporterNickname },
                category: report.category,
                tick: report.tick,
                description: report.description,
                createdAt: report.createdAt.toISOString(),
            })),
        };
    }

    async updateStatus(caseId: string, actorUserId: number, dto: UpdateReportStatusDto): Promise<CaseStatusRow> {
        return this.db.transaction(async (tx) => {
            const [current] = await tx.execute<{ status: ReportStatus }>(sql`
                SELECT status FROM moderation_cases WHERE id = ${caseId} FOR UPDATE
            `);
            if (!current) {
                throw new NotFoundException({ code: 'REPORT_CASE_NOT_FOUND', message: 'Moderation case not found' });
            }
            if (!ALLOWED_TRANSITIONS[current.status].includes(dto.status)) {
                throw new ConflictException({
                    code: 'INVALID_REPORT_STATUS_TRANSITION',
                    message: `Cannot transition a report from ${current.status} to ${dto.status}`,
                });
            }

            const values: { status: ReportStatus; updatedAt: Date; note?: string } = {
                status: dto.status,
                updatedAt: new Date(),
            };
            if (dto.note !== undefined) values.note = dto.note;
            await tx.update(schema.moderationCases).set(values)
                .where(eq(schema.moderationCases.id, caseId));

            const transition = `${current.status}→${dto.status}`;
            await tx.insert(schema.adminAuditLog).values({
                actor: String(actorUserId),
                action: 'report.status',
                targetType: 'moderation_case',
                targetId: caseId,
                reason: dto.note?.trim() || transition,
                requestMeta: { previousStatus: current.status, nextStatus: dto.status },
            });
            return { caseId, status: dto.status };
        });
    }
}

const encodeCursor = (cursor: QueueCursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

const decodeCursor = (cursor: string): QueueCursor => {
    try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('invalid base64url');
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
        const updatedAt = typeof parsed.updatedAt === 'string' ? new Date(parsed.updatedAt) : null;
        if (!Number.isInteger(parsed.reportCount) || (parsed.reportCount as number) < 0
            || !updatedAt || Number.isNaN(updatedAt.getTime()) || updatedAt.toISOString() !== parsed.updatedAt
            || typeof parsed.caseId !== 'string' || !UUID.test(parsed.caseId)) {
            throw new Error('invalid cursor fields');
        }
        return {
            reportCount: parsed.reportCount as number,
            updatedAt: parsed.updatedAt as string,
            caseId: parsed.caseId,
        };
    } catch {
        throw new BadRequestException({ code: 'INVALID_REPORT_CURSOR', message: 'Invalid report queue cursor' });
    }
};

function count(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isDuplicateReport(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
        const candidate = current as {
            code?: unknown;
            constraint?: unknown;
            constraint_name?: unknown;
            cause?: unknown;
        };
        if (candidate.code === '23505'
            && (candidate.constraint === 'reports_case_id_reporter_user_id_unique'
                || candidate.constraint_name === 'reports_case_id_reporter_user_id_unique')) return true;
        current = candidate.cause;
    }
    return false;
}
