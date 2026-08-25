import {
    HttpException,
    HttpStatus,
    ConflictException,
    Inject,
    Injectable,
    InternalServerErrorException,
    UnauthorizedException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
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
import { SessionSecurityService } from '../session/session-security.service';
import { SessionService } from '../session/session.service';
import { SanctionService } from '../sanction/sanction.service';

interface RequestSessionMetadata {
    ip: string;
    userAgent?: string;
}

interface RefreshPayload {
    sub: number;
    email: string;
    sid: string;
    type: 'refresh';
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
    | { kind: 'ok'; accessToken: string; refreshToken: string; nickname: string }
    | { kind: 'invalid' }
    | { kind: 'reuse' };

// One NAT may issue identities for ten players and retry failed startup requests in one minute.
const GUEST_AUTH_RATE_LIMIT_PER_MINUTE = 30;

@Injectable()
export class AuthService {
    private readonly keys = makeKeys(process.env.APP_ENV ?? 'dev');

    constructor(
        @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
        private readonly redisService: RedisService,
        private readonly emailService: EmailService,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
        private readonly sessionSecurity: SessionSecurityService,
        private readonly sessionService: SessionService,
        private readonly sanctionService: SanctionService,
    ) {}

    async sendVerificationCodeEmail(dto: SendEmailDto) {
        const { email, vtype } = dto;

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const redisKey = `auth:code:${vtype}:${email}`;
        await this.redisService.set(redisKey, code, 300);

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

    async login(dto: LoginDto, metadata: RequestSessionMetadata) {
        const { email, password } = dto;
        const [user] = await this.db.select().from(schema.users).where(eq(schema.users.email, email));

        if (!user || !await bcrypt.compare(password, user.passwordHash)) {
            throw new UnauthorizedException('Invalid email or password');
        }

        const status = await this.sanctionService.reconcileLoginStatus(user.id, user.accountStatus);
        if (status !== 'ACTIVE') {
            throw new UnauthorizedException('Account is not active');
        }

        await this.sessionService.purgeExpiredEncryptedIps();
        return this.createSession(user.id, user.email, user.nickname, metadata);
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
        const [cachedUser] = await this.db.select({
            id: schema.users.id,
            accountStatus: schema.users.accountStatus,
        }).from(schema.users).where(eq(schema.users.id, payload.sub));
        if (!cachedUser) {
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
        const result = await this.db.transaction<RefreshResult>(async (tx) => {
            // SanctionService locks users before deleting sessions. Keep the same
            // lock order here so a concurrent ban cannot race token rotation.
            const [user] = await tx.select({
                id: schema.users.id,
                email: schema.users.email,
                nickname: schema.users.nickname,
                accountStatus: schema.users.accountStatus,
            }).from(schema.users).where(eq(schema.users.id, payload.sub)).for('update');
            if (!user || user.accountStatus !== 'ACTIVE') {
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

            if (session.revokedAt) {
                await tx.update(schema.sessions).set({ revokedAt: now }).where(and(
                    eq(schema.sessions.userId, session.userId),
                    isNull(schema.sessions.revokedAt),
                ));
                return { kind: 'reuse' };
            }
            if (session.userId !== user.id) {
                return { kind: 'invalid' };
            }

            await tx.update(schema.sessions).set({
                revokedAt: now,
                lastUsedAt: now,
            }).where(eq(schema.sessions.id, session.id));

            const tokens = this.buildTokens(user.id, user.email);
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
            });

            return {
                kind: 'ok',
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                nickname: user.nickname,
            };
        });

        if (result.kind !== 'ok') {
            throw new UnauthorizedException('Invalid refresh token');
        }

        await this.sessionService.purgeExpiredEncryptedIps(now);
        return result;
    }

    private async createSession(userId: number, email: string, nickname: string, metadata: RequestSessionMetadata) {
        const tokens = this.buildTokens(userId, email);
        const ip = this.sessionSecurity.protectIp(metadata.ip);
        const now = new Date();
        await this.db.transaction(async (tx) => {
            const [user] = await tx.select({ status: schema.users.accountStatus })
                .from(schema.users)
                .where(eq(schema.users.id, userId))
                .for('update');
            if (!user || user.status !== 'ACTIVE') {
                throw new UnauthorizedException('Account is not active');
            }

            await tx.insert(schema.sessions).values({
                id: tokens.sessionId,
                userId,
                refreshTokenHash: this.sessionSecurity.hashRefreshToken(tokens.refreshToken),
                deviceLabel: this.sessionSecurity.deviceLabel(metadata.userAgent),
                ipHmac: ip.ipHmac,
                ipEncrypted: ip.ipEncrypted,
                createdAt: now,
                lastUsedAt: now,
                expiresAt: tokens.expiresAt,
            });
        });

        return {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            nickname,
        };
    }

    private buildTokens(userId: number, email: string) {
        const sessionId = randomUUID();
        const refreshTtlSeconds = Number(this.configService.get('JWT_REFRESH_EXPIRATION'));
        const accessToken = this.jwtService.sign({
            sub: userId,
            email,
            sid: sessionId,
            type: 'access',
        }, {
            secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
            expiresIn: Number(this.configService.get('JWT_ACCESS_EXPIRATION')),
        });
        const refreshToken = this.jwtService.sign({
            sub: userId,
            email,
            sid: sessionId,
            type: 'refresh',
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
            ) {
                throw new Error('Malformed refresh token');
            }
            return payload;
        } catch {
            throw new UnauthorizedException('Invalid refresh token');
        }
    }

    private guestSuffix(): string {
        const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        return Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
    }
}
