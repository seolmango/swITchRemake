import {
    HttpException,
    HttpStatus,
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

type RefreshResult =
    | { kind: 'ok'; accessToken: string; refreshToken: string }
    | { kind: 'invalid' }
    | { kind: 'reuse' };

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
        return this.createSession(user.id, user.email, metadata);
    }

    async createGuest(ip: string) {
        const ipKey = this.sessionSecurity.hmacIp(ip);
        const rateKey = this.keys.operation(`guest-auth-rate:${ipKey}`);
        const count = await this.redisService.incrementWithTtl(rateKey, 60);
        if (count > 5) {
            throw new HttpException({
                code: 'GUEST_AUTH_RATE_LIMITED',
                retryAfterMs: Math.max(0, await this.redisService.ttlMilliseconds(rateKey)),
                message: 'Too many guest identities requested',
            }, HttpStatus.TOO_MANY_REQUESTS);
        }

        const id = `g:${randomUUID()}`;
        const nickname = `Guest_${this.guestSuffix()}`;
        const expiresIn = Number(this.configService.get('JWT_GUEST_EXPIRATION')
            ?? this.configService.get('JWT_ACCESS_EXPIRATION')
            ?? 900);
        const accessToken = this.jwtService.sign({
            sub: id,
            nickname,
            guest: true,
            type: 'access',
        }, {
            secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
            expiresIn,
        });
        return { accessToken, guest: { id, nickname }, expiresIn };
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
            };
        });

        if (result.kind !== 'ok') {
            throw new UnauthorizedException('Invalid refresh token');
        }

        await this.sessionService.purgeExpiredEncryptedIps(now);
        return result;
    }

    private async createSession(userId: number, email: string, metadata: RequestSessionMetadata) {
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
