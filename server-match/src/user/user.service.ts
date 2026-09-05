import { Injectable, Inject, ConflictException, InternalServerErrorException, BadRequestException, NotFoundException, UnauthorizedException} from "@nestjs/common";
import { DRIZZLE } from "../database/database.module";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from '../database/schema';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from "./dto/create-user.dto";
import { RedisService } from "../redis/redis.service";
import { and, desc, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { SanctionService } from '../sanction/sanction.service';
import { SessionService } from '../session/session.service';
import { EmailService } from '../email/email.service';
import { RoomsService } from '../rooms/rooms.service';
import { EmailAuthType } from '../auth/dto/email-auth.dto';
import {
    claimVerificationCode,
    commitVerificationCodeClaim,
    issueVerificationCode,
    releaseVerificationCodeClaim,
} from '../auth/verification-code';
import { ChangePasswordDto } from './dto/change-password.dto';
import { levelFromXp } from 'shared';
import { nonNegativeInteger, percentage, readStoredStats } from './stored-stats';
import type { AuditContext } from '../admin/audit-log';
import { LEGAL_DOCUMENT_VERSIONS } from '../config/legal.settings';
import type { LegalConsentDto } from './dto/legal-consent.dto';
import { MfaService } from '../mfa/mfa.service';

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
    averageSurvivalMs: number;
    averageKills: number;
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
        private readonly emailService: EmailService,
        private readonly rooms: RoomsService,
        private readonly mfaService: MfaService,
    ) {}

    /**
     * 탈퇴 인증 코드를 **지금 로그인한 계정의 주소로** 보낸다.
     *
     * 이미 있는 `POST /auth/verify`를 쓰지 않는 이유는 그쪽이 이메일을 본문으로 받기 때문이다.
     * 그러면 화면이 사용자의 주소를 알고 있어야 하고, 남의 주소를 적어 보낼 수도 있게 된다.
     * 지울 계정은 세션이 이미 알고 있으므로 아무것도 받을 필요가 없다.
     */
    async sendDeleteCode(userId: number): Promise<{ sent: true }> {
        const [user] = await this.db.select({ email: schema.users.email, status: schema.users.accountStatus })
            .from(schema.users)
            .where(eq(schema.users.id, userId));
        if (!user || user.status !== 'ACTIVE') throw new NotFoundException('User not found');

        const code = await issueVerificationCode(this.redisService, EmailAuthType.DELETE, user.email);
        if (code === null) return { sent: true };
        if (!await this.emailService.sendDeleteAccountCodeEmail(user.email, code)) {
            throw new InternalServerErrorException('Verification email send failed');
        }
        return { sent: true };
    }

    async createUser(dto: CreateUserDto) {
        const email = dto.email.trim().toLowerCase();
        const { password, nickname, code } = dto;
        assertCurrentLegalConsent(dto);
        const claim = await claimVerificationCode(this.redisService, EmailAuthType.SIGNUP, email, code);
        if (!claim) {
            throw new BadRequestException('Invalid or expired verification code');
        }

        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);
        const agreedAt = new Date();

        try {
            if (await this.sanctionService.isEmailRegistrationBlocked(email)) {
                throw emailUnavailable();
            }
            const [newUser] = await this.db.insert(schema.users).values({
                email,
                passwordHash,
                nickname,
                termsVersion: LEGAL_DOCUMENT_VERSIONS.termsVersion,
                termsAgreedAt: agreedAt,
                privacyVersion: LEGAL_DOCUMENT_VERSIONS.privacyVersion,
                privacyAgreedAt: agreedAt,
            }).returning({
                nickname: schema.users.nickname,
            });

            // 가입이 실제로 끝난 뒤에 지운다. 닉네임 중복으로 실패했을 때까지 코드를 태우면
            // 사용자는 멀쩡한 코드를 들고도 메일을 다시 받아야 한다.
            await commitVerificationCodeClaim(this.redisService, claim);

            return newUser;
        } catch (error: any) {
            await releaseVerificationCodeClaim(this.redisService, claim).catch(() => undefined);
            if (error instanceof ConflictException) throw error;
            if (error?.code === '23505') {
                const detail = String(error.detail ?? error.details ?? error.constraint ?? '');
                if (detail.includes('email')) {
                    throw emailUnavailable();
                }
                if (detail.includes('nickname')) {
                    throw new ConflictException('Nickname already exists');
                }
            }
            throw new InternalServerErrorException('Failed to create user');
        }
    }

    async deleteUser(
        userId: number,
        code: string,
        secondFactorCode: string | undefined,
        audit: AuditContext,
    ): Promise<void> {
        const [user] = await this.db.select({ email: schema.users.email })
            .from(schema.users)
            .where(eq(schema.users.id, userId));
        if (!user) {
            throw new NotFoundException('User not found');
        }

        const claim = await claimVerificationCode(this.redisService, EmailAuthType.DELETE, user.email, code);
        if (!claim) {
            throw new BadRequestException('Invalid or expired verification code');
        }

        try {
            const mfaAuthorization = await this.mfaService.authorizeAccountDeletion(userId, secondFactorCode);
            await this.sanctionService.deleteAccount(
                userId,
                `user:${userId}`,
                'User requested account deletion',
                audit,
                mfaAuthorization,
            );
            await commitVerificationCodeClaim(this.redisService, claim);
            await this.mfaService.clearEphemeralState(userId).catch(() => undefined);
            // 지운 계정이 방에 남아 있으면 그 경기가 끝날 때까지 없는 사람이 논다.
            await this.rooms.evictActor(userId, 'account-deleted');
        } catch (error) {
            await releaseVerificationCodeClaim(this.redisService, claim).catch(() => undefined);
            throw error;
        }
    }

    async getLegalConsent(userId: number) {
        const [user] = await this.db.select({
            termsVersion: schema.users.termsVersion,
            termsAgreedAt: schema.users.termsAgreedAt,
            privacyVersion: schema.users.privacyVersion,
            privacyAgreedAt: schema.users.privacyAgreedAt,
        }).from(schema.users).where(eq(schema.users.id, userId));
        if (!user) throw new NotFoundException('User not found');
        return {
            current: LEGAL_DOCUMENT_VERSIONS,
            agreed: {
                termsVersion: user.termsVersion,
                termsAgreedAt: user.termsAgreedAt?.toISOString() ?? null,
                privacyVersion: user.privacyVersion,
                privacyAgreedAt: user.privacyAgreedAt?.toISOString() ?? null,
            },
            required: user.termsVersion !== LEGAL_DOCUMENT_VERSIONS.termsVersion
                || user.privacyVersion !== LEGAL_DOCUMENT_VERSIONS.privacyVersion,
        };
    }

    async updateLegalConsent(userId: number, dto: LegalConsentDto) {
        assertCurrentLegalConsent(dto);
        const agreedAt = new Date();
        const [updated] = await this.db.update(schema.users).set({
            termsVersion: LEGAL_DOCUMENT_VERSIONS.termsVersion,
            termsAgreedAt: agreedAt,
            privacyVersion: LEGAL_DOCUMENT_VERSIONS.privacyVersion,
            privacyAgreedAt: agreedAt,
            updatedAt: agreedAt,
        }).where(and(
            eq(schema.users.id, userId),
            eq(schema.users.accountStatus, 'ACTIVE'),
        )).returning({ id: schema.users.id });
        if (!updated) throw new NotFoundException('User not found');
        return this.getLegalConsent(userId);
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
        return this.db.transaction(async (tx) => {
            await this.sessionService.assertOwnedActiveSession(userId, currentSessionId, tx);
            /*
             * 읽었던 해시까지 조건에 넣는 낙관적 잠금이다. 두 비밀번호 변경이 겹치면 먼저
             * 커밋한 요청만 성공한다. 비밀번호 쓰기와 다른 세션 폐기는 같은 트랜잭션이므로
             * 둘 중 하나만 반영되는 계정 보안 상태가 남지 않는다.
             */
            const [updated] = await tx.update(schema.users).set({
                passwordHash,
                securityEpoch: sql`${schema.users.securityEpoch} + 1`,
            }).where(and(
                eq(schema.users.id, userId),
                eq(schema.users.passwordHash, user.passwordHash),
            )).returning({ id: schema.users.id });
            if (!updated) {
                throw new ConflictException({
                    code: 'PASSWORD_CHANGED_CONCURRENTLY',
                    message: 'The password changed while this request was being processed',
                });
            }
            const revokedCount = await this.sessionService.revokeOthers(userId, currentSessionId, tx);
            return { revokedCount };
        });
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
        const tagCount = nonNegativeInteger(stored.kill);
        const survivedMs = nonNegativeInteger(stored.survived_ms);
        const survivedGames = nonNegativeInteger(stored.survived_games);
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
            tagCount,
            deathOrder: nonNegativeInteger(stored.death_order),
            winRate: percentage(wins, games),
            switchSuccessRate: percentage(switchSuccess, switchTry),
            averageSurvivalMs: survivedGames === 0 ? 0 : Math.round(survivedMs / survivedGames),
            averageKills: games === 0 ? 0 : Math.round(tagCount / games * 10) / 10,
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

/** 기존 가입 여부와 탈퇴 제재 여부가 같은 상태·본문으로 나가게 하는 단일 생성점이다. */
function emailUnavailable(): ConflictException {
    return new ConflictException({ code: 'EMAIL_UNAVAILABLE', message: 'Email is unavailable' });
}

function assertCurrentLegalConsent(dto: LegalConsentDto): void {
    if (!dto.agreements?.termsOfService || !dto.agreements.privacyPolicy) {
        throw new BadRequestException({ code: 'LEGAL_CONSENT_REQUIRED', message: 'Legal consent is required' });
    }
    if (dto.agreements.termsOfService.version !== LEGAL_DOCUMENT_VERSIONS.termsVersion
        || dto.agreements.privacyPolicy.version !== LEGAL_DOCUMENT_VERSIONS.privacyVersion) {
        throw new ConflictException({
            code: 'LEGAL_VERSION_OUTDATED',
            message: 'Legal document versions changed; review and consent again',
            ...LEGAL_DOCUMENT_VERSIONS,
        });
    }
}
