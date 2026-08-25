import { Injectable, Inject, ConflictException, InternalServerErrorException, BadRequestException, NotFoundException, UnauthorizedException} from "@nestjs/common";
import { DRIZZLE } from "../database/database.module";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from '../database/schema';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from "./dto/create-user.dto";
import { RedisService } from "../redis/redis.service";
import { and, desc, eq, isNotNull, lt, or } from 'drizzle-orm';
import { SanctionService } from '../sanction/sanction.service';
import { SessionService } from '../session/session.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { levelFromXp } from 'shared';
import { DEFAULT_STATS, nonNegativeInteger, percentage, readStoredStats, type StoredStats } from './stored-stats';

export interface UserStatsResponse {
    /** 누적 XP에서 센 값. 저장된 값이 아니다 — `shared`의 `levelFromXp`가 유일한 정의다. */
    level: number;
    xp: number;
    /** 이번 레벨에서 모은 XP와 다음 레벨까지 필요한 총량. 진행도를 그리는 데 쓴다. */
    xpIntoLevel: number;
    xpForNextLevel: number;
    games: number;
    wins: number;
    switchTry: number;
    switchSuccess: number;
    tagCount: number;
    deathOrder: number;
    winRate: number;
    switchSuccessRate: number;
}

export interface UserMatchHistoryItem {
    matchId: string;
    endedAt: string;
    map: string;
    won: boolean;
    tagCount: number;
    taggedCount: number;
    switchTry: number;
    switchSuccess: number;
    survivedMs: number;
}

export interface UserMatchHistoryResponse {
    matches: UserMatchHistoryItem[];
    nextCursor: string | null;
}

interface MatchCursor {
    endedAt: string;
    matchId: string;
}

const MAX_MATCH_HISTORY_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const decodeCursor = (cursor: string): MatchCursor => {
    try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('invalid base64url');
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (typeof parsed.endedAt !== 'string' || typeof parsed.matchId !== 'string') throw new Error('invalid fields');
        const endedAt = new Date(parsed.endedAt);
        if (Number.isNaN(endedAt.getTime()) || endedAt.toISOString() !== parsed.endedAt || !UUID.test(parsed.matchId)) {
            throw new Error('invalid values');
        }
        return { endedAt: parsed.endedAt, matchId: parsed.matchId };
    } catch {
        throw new BadRequestException({ code: 'INVALID_MATCH_CURSOR', message: 'Invalid match history cursor' });
    }
};

const encodeCursor = (cursor: MatchCursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

@Injectable()
export class UserService {
    constructor(
        @Inject(DRIZZLE) private db: PostgresJsDatabase<typeof schema>,
        private readonly redisService: RedisService,
        private readonly sanctionService: SanctionService,
        // Password changes must revoke every other authenticated session, so
        // this application service intentionally owns the SessionService dependency.
        private readonly sessionService: SessionService,
    ) {}

    async createUser(dto: CreateUserDto) {
        const { email, password, nickname, code } = dto;
        const redisKey = `auth:code:signup:${email}`;

        const savedCode = await this.redisService.get(redisKey);
        if (!savedCode) {
            throw new BadRequestException('Verification code expired or not found');
        }
        if (savedCode !== code) {
            throw new BadRequestException('Invalid verification code');
        }

        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        try {
            const [newUser] = await this.db.insert(schema.users).values({
                email,
                passwordHash,
                nickname,
            }).returning({
                nickname: schema.users.nickname,
            });

            await this.redisService.del(redisKey);

            return newUser;
        } catch (error: any) {
            if (error.code === '23505') {
                if (error.details.includes('email')) {
                    throw new ConflictException('Email already exists');
                }
                if (error.details.includes('nickname')) {
                    throw new ConflictException('Nickname already exists');
                }
            }
            throw new InternalServerErrorException('Failed to create user');
        }
    }

    async deleteUser(
        userId: number,
        code: string,
        requestMeta: Record<string, unknown>,
    ): Promise<void> {
        const [user] = await this.db.select({ email: schema.users.email })
            .from(schema.users)
            .where(eq(schema.users.id, userId));
        if (!user) {
            throw new NotFoundException('User not found');
        }

        const redisKey = `auth:code:delete:${user.email}`;
        const savedCode = await this.redisService.get(redisKey);
        if (!savedCode || savedCode !== code) {
            throw new BadRequestException('Invalid or expired verification code');
        }

        await this.sanctionService.deleteAccount(
            userId,
            `user:${userId}`,
            'User requested account deletion',
            requestMeta,
        );
        await this.redisService.del(redisKey);
    }

    async changePassword(userId: number, currentSessionId: string, dto: ChangePasswordDto) {
        await this.sessionService.assertOwnedActiveSession(userId, currentSessionId);
        const [user] = await this.db.select({ passwordHash: schema.users.passwordHash })
            .from(schema.users)
            .where(eq(schema.users.id, userId));
        if (!user) throw new NotFoundException('User not found');

        if (!await bcrypt.compare(dto.currentPassword, user.passwordHash)) {
            throw new UnauthorizedException('Current password is incorrect');
        }
        if (await bcrypt.compare(dto.newPassword, user.passwordHash)) {
            throw new BadRequestException('New password must differ from the current password');
        }

        const passwordHash = await bcrypt.hash(dto.newPassword, 10);
        await this.db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId));
        const revokedCount = await this.sessionService.revokeOthers(userId, currentSessionId);
        return { revokedCount };
    }

    async getStats(userId: number): Promise<UserStatsResponse> {
        const [row] = await this.db.select({ stats: schema.users.stats })
            .from(schema.users)
            .where(eq(schema.users.id, userId));
        if (!row) throw new NotFoundException('User not found');

        const stored = readStoredStats(row.stats);
        const games = nonNegativeInteger(stored.games);
        const wins = nonNegativeInteger(stored.wins);
        const switchTry = nonNegativeInteger(stored.sw_try);
        const switchSuccess = nonNegativeInteger(stored.sw_su);
        const xp = nonNegativeInteger(stored.xp);
        const progress = levelFromXp(xp);
        return {
            level: progress.level,
            xp,
            xpIntoLevel: progress.xpIntoLevel,
            xpForNextLevel: progress.xpForNextLevel,
            games,
            wins,
            switchTry,
            switchSuccess,
            tagCount: nonNegativeInteger(stored.kill),
            deathOrder: nonNegativeInteger(stored.death_order),
            winRate: percentage(wins, games),
            switchSuccessRate: percentage(switchSuccess, switchTry),
        };
    }

    async getMatches(userId: number, requestedLimit = 20, encodedCursor?: string): Promise<UserMatchHistoryResponse> {
        const limit = Math.min(MAX_MATCH_HISTORY_LIMIT, Math.max(1, requestedLimit));
        const cursor = encodedCursor ? decodeCursor(encodedCursor) : null;
        const cursorCondition = cursor
            ? or(
                lt(schema.matches.endedAt, new Date(cursor.endedAt)),
                and(eq(schema.matches.endedAt, new Date(cursor.endedAt)), lt(schema.matches.matchId, cursor.matchId)),
            )
            : undefined;
        const rows = await this.db.select({
            matchId: schema.matchParticipants.matchId,
            endedAt: schema.matches.endedAt,
            map: schema.matches.mapId,
            won: schema.matchParticipants.isWinner,
            tagCount: schema.matchParticipants.tagCount,
            taggedCount: schema.matchParticipants.taggedCount,
            switchTry: schema.matchParticipants.switchTry,
            switchSuccess: schema.matchParticipants.switchSuccess,
            survivedMs: schema.matchParticipants.survivedMs,
        }).from(schema.matchParticipants)
            .innerJoin(schema.matches, eq(schema.matches.matchId, schema.matchParticipants.matchId))
            .where(and(
                eq(schema.matchParticipants.userId, userId),
                isNotNull(schema.matches.endedAt),
                cursorCondition,
            ))
            .orderBy(desc(schema.matches.endedAt), desc(schema.matches.matchId))
            .limit(limit + 1);

        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const matches = page.flatMap((row): UserMatchHistoryItem[] => row.endedAt ? [{
            matchId: row.matchId,
            endedAt: row.endedAt.toISOString(),
            map: row.map,
            won: row.won,
            tagCount: row.tagCount,
            taggedCount: row.taggedCount,
            switchTry: row.switchTry,
            switchSuccess: row.switchSuccess,
            survivedMs: row.survivedMs,
        }] : []);
        const last = hasMore ? matches.at(-1) : undefined;
        return {
            matches,
            nextCursor: last ? encodeCursor({ endedAt: last.endedAt, matchId: last.matchId }) : null,
        };
    }
}
