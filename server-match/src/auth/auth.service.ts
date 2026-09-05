import {
    HttpException,
    HttpStatus,
    ConflictException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    UnauthorizedException,
} from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomInt, randomUUID } from 'node:crypto';
import { makeKeys } from 'shared';
import * as bcrypt from 'bcrypt';
import { RedisService } from '../redis/redis.service';
import { EmailService } from '../email/email.service';
import { EmailAuthType, SendEmailDto } from './dto/email-auth.dto';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SessionSecurityService } from '../session/session-security.service';
import { SessionService } from '../session/session.service';
import { SanctionService } from '../sanction/sanction.service';
import {
    claimVerificationCode,
    commitVerificationCodeClaim,
    issueVerificationCode,
    releaseVerificationCodeClaim,
} from './verification-code';
import { MfaService } from '../mfa/mfa.service';
import type { LoginMfaAuthorization, MfaAuthorization } from '../mfa/mfa.types';

interface RequestSessionMetadata {
    ip: string;
    userAgent?: string;
}

interface RefreshPayload {
    sub: number;
    email: string;
    sid: string;
    type: 'refresh';
    fid: string;
    gen: number;
    sev: number;
    exp?: number;
}

interface GuestRefreshPayload {
    sub: string;
    sid: string;
    jti: string;
    type: 'guest-refresh';
}

interface GuestSession {
    id: string;
    nickname: string;
    jti: string;
}

interface AuthenticatedActor {
    id: number | string;
    sessionId: string;
    guest: boolean;
}

type RefreshResult =
    | {
        kind: 'ok';
        accessToken: string;
        refreshToken: string;
        nickname: string;
        sessionId: string;
        familyId: string;
        generation: number;
    }
    | { kind: 'invalid' }
    | { kind: 'reuse'; familyId: string; generation: number };

interface CachedRotationResult {
    accessToken: string;
    refreshToken: string;
    nickname: string;
}

// One NAT may issue identities for ten players and retry failed startup requests in one minute.
const GUEST_AUTH_RATE_LIMIT_PER_MINUTE = 30;
const REFRESH_ROTATION_GRACE_MS = 10_000;
const DUMMY_PASSWORD_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

export function passwordHashForComparison(passwordHash: string | undefined): string {
    return passwordHash ?? DUMMY_PASSWORD_HASH;
}

@Injectable()
export class AuthService {
    private readonly keys = makeKeys(process.env.APP_ENV ?? 'dev');
    private readonly logger = new Logger(AuthService.name);

    constructor(
        @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
        private readonly redisService: RedisService,
        private readonly emailService: EmailService,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
        private readonly sessionSecurity: SessionSecurityService,
        private readonly sessionService: SessionService,
        private readonly sanctionService: SanctionService,
        private readonly mfaService: MfaService,
    ) {}

    async sendVerificationCodeEmail(dto: SendEmailDto) {
        const email = dto.email.trim().toLowerCase();
        const { vtype } = dto;
        const code = await issueVerificationCode(this.redisService, vtype, email);
        if (code === null) {
            return { message: 'Verification code sent successfully' };
        }

        let emailSent = false;
        switch (vtype) {
            case EmailAuthType.SIGNUP:
                emailSent = await this.emailService.sendRegistrationCodeEmail(email, code);
                break;
            case EmailAuthType.RESET_PASSWORD:
                emailSent = await this.emailService.sendPasswordResetCodeEmail(email, code);
                break;
            case EmailAuthType.DELETE:
                emailSent = await this.emailService.sendDeleteAccountCodeEmail(email, code);
                break;
        }
        if (!emailSent) {
            throw new InternalServerErrorException('Verification email send failed');
        }

        return { message: 'Verification code sent successfully' };
    }

    /**
     * 비밀번호를 잊은 사람이 메일 코드로 다시 정한다.
     *
     * **없는 계정에도 성공을 돌려준다.** 응답이 갈리면 이 엔드포인트가 곧 "이 메일이 가입돼
     * 있는지" 조회기가 된다. 코드는 어차피 그 주소로만 갔으므로, 모르는 주소에는 코드가 없다.
     *
     * 성공하면 **그 계정의 모든 세션을 끊는다.** 비밀번호를 되찾는 상황은 대개 남이 들어와
     * 있을지도 모르는 상황이고, 그때 남의 세션을 살려 두면 되찾은 것이 아니다.
     */
    async resetPassword(dto: ResetPasswordDto): Promise<{ reset: boolean }> {
        const email = dto.email.trim().toLowerCase();
        const claim = await claimVerificationCode(
            this.redisService,
            EmailAuthType.RESET_PASSWORD,
            email,
            dto.code,
        );
        if (!claim) {
            throw new HttpException('Invalid or expired verification code', HttpStatus.BAD_REQUEST);
        }
        try {
            const passwordHash = await bcrypt.hash(dto.newPassword, 10);
            const [candidate] = await this.db.select({
                id: schema.users.id,
                accountStatus: schema.users.accountStatus,
            }).from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`);
            let mfaAuthorization: MfaAuthorization = { kind: 'not-enabled' };
            if (candidate?.accountStatus === 'ACTIVE') {
                mfaAuthorization = await this.mfaService.authorizePasswordReset(
                    candidate.id,
                    dto.secondFactorCode,
                );
            }
            await this.db.transaction(async (tx) => {
                const [user] = await tx.select({
                    id: schema.users.id,
                    accountStatus: schema.users.accountStatus,
                }).from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`).for('update');
                if (!user || user.accountStatus !== 'ACTIVE') return;

                await this.mfaService.assertAccountAuthorizationCurrent(tx, user.id, mfaAuthorization);

                await tx.update(schema.users).set({
                    passwordHash,
                    securityEpoch: sql`${schema.users.securityEpoch} + 1`,
                    updatedAt: new Date(),
                }).where(eq(schema.users.id, user.id));
                await this.sessionService.revokeAll(user.id, tx);
            });
            // 없는 계정에도 코드는 소모한다. 코드 수명이 가입 여부를 드러내면 안 된다.
            await commitVerificationCodeClaim(this.redisService, claim);
            return { reset: true };
        } catch (error) {
            await releaseVerificationCodeClaim(this.redisService, claim).catch(() => undefined);
            throw error;
        }
    }

    async login(dto: LoginDto, metadata: RequestSessionMetadata, trustedDeviceToken?: string) {
        const email = dto.email.trim().toLowerCase();
        const { password } = dto;
        const [user] = await this.db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`);

        const comparedHash = passwordHashForComparison(user?.passwordHash);
        const passwordMatches = await bcrypt.compare(password, comparedHash);
        if (!user || !passwordMatches) {
            throw new UnauthorizedException('Invalid email or password');
        }

        const status = await this.sanctionService.reconcileLoginStatus(user.id, user.accountStatus);
        if (status !== 'ACTIVE') {
            throw new UnauthorizedException('Account is not active');
        }

        const method = await this.mfaService.getMethod(user.id);
        if (method) {
            if (!await this.mfaService.isTrustedDevice(user.id, trustedDeviceToken)) {
                return this.mfaService.beginLoginChallenge(user.id, user.securityEpoch, method);
            }
            return this.createSession(
                user.id,
                user.securityEpoch,
                metadata,
                { kind: 'trusted-device', token: trustedDeviceToken! },
                false,
            );
        }

        return this.createSession(user.id, user.securityEpoch, metadata, { kind: 'not-enabled' }, false);
    }

    async resendLoginMfaEmail(challengeToken: string) {
        return this.mfaService.resendLoginEmail(challengeToken);
    }

    async completeMfaLogin(
        challengeToken: string,
        code: string,
        trustDevice: boolean,
        metadata: RequestSessionMetadata,
    ) {
        const challenge = await this.mfaService.completeLoginChallenge(challengeToken, code);
        return this.createSession(
            challenge.userId,
            challenge.securityEpoch,
            metadata,
            { kind: 'verified', method: challenge.method },
            trustDevice,
        );
    }

    async assertIdentitySwitchAllowed(actorId: number | string | undefined): Promise<void> {
        if (actorId === undefined) return;
        if (await this.redisService.get(this.keys.userActiveRoom(actorId))) {
            throw new ConflictException({ code: 'IDENTITY_SWITCH_DURING_ROOM', message: 'Leave the active room first' });
        }
    }

    async createGuest(ip: string) {
        const ipKey = this.sessionSecurity.hmacIp(ip);
        const rateKey = this.keys.operation(`guest-auth-rate:${ipKey}`);
        const count = await this.redisService.incrementWithTtl(rateKey, 60);
        if (count > GUEST_AUTH_RATE_LIMIT_PER_MINUTE) {
            throw new HttpException({
                code: 'GUEST_AUTH_RATE_LIMITED',
                retryAfterMs: Math.max(0, await this.redisService.ttlMilliseconds(rateKey)),
                message: 'Too many guest identities requested',
            }, HttpStatus.TOO_MANY_REQUESTS);
        }

        const id = `g:${randomUUID()}`;
        const nickname = `Guest_${this.guestSuffix()}`;
        const sid = randomUUID();
        const jti = randomUUID();
        const tokens = this.buildGuestTokens({ id, nickname, jti }, sid);
        await this.redisService.set(
            this.keys.guestSession(sid),
            JSON.stringify({ id, nickname, jti } satisfies GuestSession),
            tokens.refreshExpiresIn,
        );
        return { ...tokens, guest: { id, nickname } };
    }

    async refreshGuest(refreshToken: string) {
        const payload = this.verifyGuestRefreshToken(refreshToken);
        const key = this.keys.guestSession(payload.sid);
        const raw = await this.redisService.get(key);
        if (!raw) throw new UnauthorizedException('Invalid guest refresh token');

        let session: GuestSession;
        try {
            session = JSON.parse(raw) as GuestSession;
        } catch {
            throw new UnauthorizedException('Invalid guest session');
        }
        if (session.id !== payload.sub || session.jti !== payload.jti || !this.isGuestSession(session)) {
            throw new UnauthorizedException('Invalid guest refresh token');
        }

        const next: GuestSession = { ...session, jti: randomUUID() };
        const tokens = this.buildGuestTokens(next, payload.sid);
        const rotated = await this.redisService.compareAndSetWithTtl(
            key,
            raw,
            JSON.stringify(next),
            tokens.refreshExpiresIn,
        );
        if (!rotated) throw new UnauthorizedException('Guest refresh token was already used');
        return { ...tokens, guest: { id: next.id, nickname: next.nickname } };
    }

    async logout(actor: AuthenticatedActor): Promise<void> {
        await this.assertIdentitySwitchAllowed(actor.id);
        if (actor.guest) {
            await this.redisService.del(this.keys.guestSession(actor.sessionId));
            return;
        }
        if (typeof actor.id === 'number') {
            await this.sessionService.revokeCurrent(actor.id, actor.sessionId);
        }
    }

    async refresh(refreshToken: string, metadata: RequestSessionMetadata) {
        const payload = this.verifyRefreshToken(refreshToken);
        if (payload.exp && payload.exp * 1000 <= Date.now()) {
            throw new UnauthorizedException('Invalid refresh token');
        }
        const [cachedUser] = await this.db.select({
            id: schema.users.id,
            accountStatus: schema.users.accountStatus,
            securityEpoch: schema.users.securityEpoch,
        }).from(schema.users).where(eq(schema.users.id, payload.sub));
        if (!cachedUser || cachedUser.securityEpoch !== payload.sev) {
            throw new UnauthorizedException('Invalid refresh token');
        }

        const status = await this.sanctionService.reconcileLoginStatus(
            cachedUser.id,
            cachedUser.accountStatus,
        );
        if (status !== 'ACTIVE') {
            throw new UnauthorizedException('Invalid refresh token');
        }

        const tokenHash = this.sessionSecurity.hashRefreshToken(refreshToken);
        const now = new Date();
        let cachedRotation: string | null = null;
        try {
            cachedRotation = await this.redisService.get(this.rotationResultKey(tokenHash));
        } catch {
            cachedRotation = null;
        }
        if (cachedRotation) {
            try {
                return JSON.parse(cachedRotation) as CachedRotationResult;
            } catch {
                // 손상된 캐시는 정상 회전으로 취급하지 않는다. DB가 재사용 여부를 판정한다.
            }
        }
        const rotationLockId = randomUUID();
        let ownsRotation = true;
        try {
            ownsRotation = await this.redisService.setIfAbsent(
                this.rotationLockKey(tokenHash),
                rotationLockId,
                3,
            );
        } catch {
            // Redis가 없을 때는 DB의 일회성 판정을 택한다. 중복 편의보다 재사용 차단이 우선이다.
        }
        if (!ownsRotation) {
            // 먼저 들어온 회전이 DB를 커밋하고 결과 캐시를 쓰는 짧은 구간만 기다린다.
            for (let attempt = 0; attempt < 40; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                const cached = await this.redisService.get(this.rotationResultKey(tokenHash));
                if (cached) return JSON.parse(cached) as CachedRotationResult;
            }
            throw new UnauthorizedException('Invalid refresh token');
        }
        const result = await this.db.transaction<RefreshResult>(async (tx) => {
            // SanctionService locks users before deleting sessions. Keep the same
            // lock order here so a concurrent ban cannot race token rotation.
            const [user] = await tx.select({
                id: schema.users.id,
                email: schema.users.email,
                nickname: schema.users.nickname,
                accountStatus: schema.users.accountStatus,
                securityEpoch: schema.users.securityEpoch,
            }).from(schema.users).where(eq(schema.users.id, payload.sub)).for('update');
            if (!user || user.accountStatus !== 'ACTIVE' || user.securityEpoch !== payload.sev) {
                return { kind: 'invalid' };
            }

            const [session] = await tx.select()
                .from(schema.sessions)
                .where(and(
                    eq(schema.sessions.id, payload.sid),
                    eq(schema.sessions.refreshTokenHash, tokenHash),
                ))
                .for('update');
            if (!session) {
                return { kind: 'invalid' };
            }

            if (session.expiresAt <= now || (payload.exp && payload.exp * 1000 <= now.getTime())) {
                if (!session.revokedAt) {
                    await tx.update(schema.sessions).set({ revokedAt: now })
                        .where(eq(schema.sessions.id, session.id));
                }
                return { kind: 'invalid' };
            }

            if (session.userId !== user.id) {
                return { kind: 'invalid' };
            }
            if (session.familyId !== payload.fid || session.generation !== payload.gen) {
                return { kind: 'invalid' };
            }
            if (session.revokedAt) {
                await tx.update(schema.sessions).set({ revokedAt: now }).where(and(
                    eq(schema.sessions.familyId, session.familyId),
                    isNull(schema.sessions.revokedAt),
                ));
                await tx.insert(schema.authSecurityEvents).values({
                    userId: user.id,
                    event: 'refresh-token-reuse',
                    familyId: session.familyId,
                    generation: session.generation,
                });
                return { kind: 'reuse', familyId: session.familyId, generation: session.generation };
            }

            await tx.update(schema.sessions).set({
                revokedAt: now,
                lastUsedAt: now,
            }).where(eq(schema.sessions.id, session.id));

            const tokens = this.buildTokens(
                user.id,
                user.email,
                session.familyId,
                session.generation + 1,
                user.securityEpoch,
            );
            const ip = this.sessionSecurity.protectIp(metadata.ip);
            await tx.insert(schema.sessions).values({
                id: tokens.sessionId,
                userId: user.id,
                refreshTokenHash: this.sessionSecurity.hashRefreshToken(tokens.refreshToken),
                deviceLabel: this.sessionSecurity.deviceLabel(metadata.userAgent),
                ipHmac: ip.ipHmac,
                ipEncrypted: ip.ipEncrypted,
                createdAt: now,
                lastUsedAt: now,
                expiresAt: tokens.expiresAt,
                familyId: session.familyId,
                generation: session.generation + 1,
            });

            return {
                kind: 'ok',
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                nickname: user.nickname,
                sessionId: tokens.sessionId,
                familyId: session.familyId,
                generation: session.generation + 1,
            };
        });

        if (result.kind !== 'ok') {
            await this.redisService.compareAndDelete(this.rotationLockKey(tokenHash), rotationLockId).catch(() => undefined);
            if (result.kind === 'reuse') {
                this.logger.warn(JSON.stringify({
                    event: 'refresh-token-reuse',
                    userId: payload.sub,
                    familyId: result.familyId,
                    generation: result.generation,
                }));
            }
            throw new UnauthorizedException('Invalid refresh token');
        }

        const response: CachedRotationResult = {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            nickname: result.nickname,
        };
        try {
            // 옛 토큰의 짧은 중복 요청에는 이 결과 자체를 돌려준다. successor를 다시 돌리지는 않는다.
            await this.redisService.set(
                this.rotationResultKey(tokenHash),
                JSON.stringify(response),
                REFRESH_ROTATION_GRACE_MS / 1000,
            );
            await this.redisService.compareAndDelete(this.rotationLockKey(tokenHash), rotationLockId);
        } catch {
            // 커밋된 새 토큰은 전달한다. 캐시가 없으면 다음 재사용은 안전하게 family를 닫는다.
        }
        return response;
    }

    private async createSession(
        userId: number,
        expectedSecurityEpoch: number,
        metadata: RequestSessionMetadata,
        mfaAuthorization: LoginMfaAuthorization,
        trustDevice: boolean,
    ) {
        const ip = this.sessionSecurity.protectIp(metadata.ip);
        const now = new Date();
        const tokens = await this.db.transaction(async (tx) => {
            const [user] = await tx.select({
                status: schema.users.accountStatus,
                email: schema.users.email,
                nickname: schema.users.nickname,
                securityEpoch: schema.users.securityEpoch,
            })
                .from(schema.users)
                .where(eq(schema.users.id, userId))
                .for('update');
            if (!user || user.status !== 'ACTIVE' || user.securityEpoch !== expectedSecurityEpoch) {
                throw new UnauthorizedException('Account is not active');
            }

            await this.mfaService.assertLoginAuthorized(userId, mfaAuthorization, tx);

            const familyId = randomUUID();
            const createdTokens = this.buildTokens(userId, user.email, familyId, 0, user.securityEpoch);
            await tx.insert(schema.sessions).values({
                id: createdTokens.sessionId,
                userId,
                refreshTokenHash: this.sessionSecurity.hashRefreshToken(createdTokens.refreshToken),
                deviceLabel: this.sessionSecurity.deviceLabel(metadata.userAgent),
                ipHmac: ip.ipHmac,
                ipEncrypted: ip.ipEncrypted,
                createdAt: now,
                lastUsedAt: now,
                expiresAt: createdTokens.expiresAt,
                familyId,
                generation: 0,
            });
            const trustedDevice = trustDevice && mfaAuthorization.kind === 'verified'
                ? await this.mfaService.registerTrustedDevice(userId, metadata.userAgent, tx)
                : undefined;
            return { ...createdTokens, nickname: user.nickname, trustedDevice };
        });

        return {
            mfaRequired: false as const,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            nickname: tokens.nickname,
            trustedDeviceToken: tokens.trustedDevice?.token,
            trustedDeviceExpiresAt: tokens.trustedDevice?.expiresAt,
        };
    }

    private buildTokens(userId: number, email: string, familyId: string, generation: number, securityEpoch: number) {
        const sessionId = randomUUID();
        const refreshTtlSeconds = Number(this.configService.get('JWT_REFRESH_EXPIRATION'));
        const accessToken = this.jwtService.sign({
            sub: userId,
            email,
            sid: sessionId,
            type: 'access',
            sev: securityEpoch,
        }, {
            secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
            expiresIn: Number(this.configService.get('JWT_ACCESS_EXPIRATION')),
        });
        const refreshToken = this.jwtService.sign({
            sub: userId,
            email,
            sid: sessionId,
            type: 'refresh',
            fid: familyId,
            gen: generation,
            sev: securityEpoch,
        }, {
            secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
            expiresIn: refreshTtlSeconds,
        });

        return {
            sessionId,
            accessToken,
            refreshToken,
            expiresAt: new Date(Date.now() + refreshTtlSeconds * 1000),
        };
    }

    private buildGuestTokens(session: GuestSession, sessionId: string) {
        const expiresIn = Number(this.configService.get('JWT_GUEST_EXPIRATION')
            ?? this.configService.get('JWT_ACCESS_EXPIRATION')
            ?? 900);
        const refreshExpiresIn = Number(this.configService.get('JWT_GUEST_REFRESH_EXPIRATION') ?? 3600);
        const accessToken = this.jwtService.sign({
            sub: session.id,
            nickname: session.nickname,
            guest: true,
            sid: sessionId,
            type: 'guest-access',
        }, {
            secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
            expiresIn,
        });
        const refreshToken = this.jwtService.sign({
            sub: session.id,
            sid: sessionId,
            jti: session.jti,
            type: 'guest-refresh',
        }, {
            // 대체값을 두지 않는다. `JWT_REFRESH_SECRET`으로 조용히 넘어가면 게스트 refresh 토큰과
            // 계정 refresh 토큰이 같은 키로 서명되어, 두 종류를 나눈 이유가 사라진다.
            // 값이 없으면 부팅이 실패한다(main.ts의 assertDistinctJwtSecrets).
            secret: this.configService.get<string>('JWT_GUEST_REFRESH_SECRET'),
            expiresIn: refreshExpiresIn,
        });
        return { accessToken, refreshToken, expiresIn, refreshExpiresIn };
    }

    private verifyGuestRefreshToken(refreshToken: string): GuestRefreshPayload {
        try {
            const payload = this.jwtService.verify<GuestRefreshPayload>(refreshToken, {
                secret: this.configService.get<string>('JWT_GUEST_REFRESH_SECRET'),
            });
            if (
                payload.type !== 'guest-refresh'
                || typeof payload.sub !== 'string'
                || !/^g:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.sub)
                || typeof payload.sid !== 'string'
                || typeof payload.jti !== 'string'
            ) throw new Error('Malformed guest refresh token');
            return payload;
        } catch {
            throw new UnauthorizedException('Invalid guest refresh token');
        }
    }

    private isGuestSession(value: GuestSession): boolean {
        return typeof value.id === 'string'
            && /^g:[0-9a-f-]{36}$/i.test(value.id)
            && typeof value.nickname === 'string'
            && /^Guest_[A-HJ-NP-Z2-9]{6}$/.test(value.nickname)
            && typeof value.jti === 'string';
    }

    private verifyRefreshToken(refreshToken: string): RefreshPayload {
        try {
            const payload = this.jwtService.verify<RefreshPayload>(refreshToken, {
                secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
                ignoreExpiration: true,
            });
            if (
                payload.type !== 'refresh'
                || !Number.isInteger(payload.sub)
                || typeof payload.email !== 'string'
                || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.sid)
                || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.fid)
                || !Number.isInteger(payload.gen)
                || payload.gen < 0
                || !Number.isInteger(payload.sev)
                || payload.sev < 0
            ) {
                throw new Error('Malformed refresh token');
            }
            return payload;
        } catch {
            throw new UnauthorizedException('Invalid refresh token');
        }
    }

    private rotationResultKey(tokenHash: string): string {
        return `auth:rotate-result:${tokenHash}`;
    }

    private rotationLockKey(tokenHash: string): string {
        return `auth:rotate-lock:${tokenHash}`;
    }

    private guestSuffix(): string {
        const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        return Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
    }
}
