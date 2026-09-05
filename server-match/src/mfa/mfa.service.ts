import {
    ConflictException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    InternalServerErrorException,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gt, isNull, lt, lte, or } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'node:crypto';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';
import { EmailService } from '../email/email.service';
import { RedisService } from '../redis/redis.service';
import { SessionSecurityService } from '../session/session-security.service';
import type { SessionTransaction } from '../session/session.service';
import type { AuditContext } from '../admin/audit-log';
import { auditContext } from '../admin/audit-log';
import {
    claimVerificationCode,
    commitVerificationCodeClaim,
    issueVerificationCode,
    MFA_EMAIL_PURPOSE,
    type VerificationPurpose,
} from '../auth/verification-code';
import { MfaSecurityService, matchingTotpStep } from './mfa-security.service';
import type { LoginMfaAuthorization, MfaAuthorization, MfaMethod } from './mfa.types';

const LOGIN_CHALLENGE_TTL_SECONDS = 5 * 60;
const LOGIN_CHALLENGE_CLAIM_TTL_SECONDS = 30;
const TOTP_SETUP_TTL_SECONDS = 10 * 60;
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_BCRYPT_ROUNDS = 10;
const BACKUP_CODE_PATTERN = /^[0-9A-F]{8}(?:-[A-Z2-7]{4}){4}$/;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

interface LoginChallengeState {
    userId: number;
    securityEpoch: number;
    method: MfaMethod;
}

interface TotpSetupState {
    setupToken: string;
    encryptedSecret: string;
    securityEpoch: number;
}

interface BackupCodeRow {
    userId: number;
    codeId: string;
    codeHash: string;
}

export interface CompletedLoginChallenge extends LoginChallengeState {}

function mfaRequired(): HttpException {
    return new HttpException({
        code: 'MFA_REQUIRED',
        message: 'A second factor is required',
    }, HttpStatus.UNAUTHORIZED);
}

function invalidFactor(): UnauthorizedException {
    return new UnauthorizedException({
        code: 'INVALID_SECOND_FACTOR',
        message: 'Invalid or expired second factor',
    });
}

function backupSecret(length: number): string {
    const bytes = randomBytes(length);
    return Array.from(bytes, (byte) => BASE32_ALPHABET[byte! & 31]).join('');
}

@Injectable()
export class MfaService {
    private readonly trustedDeviceDays: number;

    constructor(
        @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
        private readonly redis: RedisService,
        private readonly email: EmailService,
        private readonly security: MfaSecurityService,
        private readonly sessionSecurity: SessionSecurityService,
        config: ConfigService,
    ) {
        this.trustedDeviceDays = Number(config.get<string>('MFA_TRUSTED_DEVICE_DAYS', '30'));
        if (!Number.isInteger(this.trustedDeviceDays) || this.trustedDeviceDays < 1 || this.trustedDeviceDays > 90) {
            throw new Error('MFA_TRUSTED_DEVICE_DAYS must be an integer between 1 and 90');
        }
    }

    async getStatus(userId: number) {
        const [settings, backupCodes] = await Promise.all([
            this.db.select({ method: schema.mfaSettings.method })
                .from(schema.mfaSettings)
                .where(eq(schema.mfaSettings.userId, userId)),
            this.db.select({ id: schema.mfaBackupCodes.id })
                .from(schema.mfaBackupCodes)
                .where(and(
                    eq(schema.mfaBackupCodes.userId, userId),
                    isNull(schema.mfaBackupCodes.usedAt),
                )),
        ]);
        const setting = settings[0];
        return {
            enabled: Boolean(setting),
            method: setting?.method ?? null,
            backupCodesRemaining: setting ? backupCodes.length : 0,
        };
    }

    async getMethod(userId: number): Promise<MfaMethod | null> {
        const [setting] = await this.db.select({ method: schema.mfaSettings.method })
            .from(schema.mfaSettings)
            .where(eq(schema.mfaSettings.userId, userId));
        return setting?.method ?? null;
    }

    async isTrustedDevice(userId: number, token: string | undefined): Promise<boolean> {
        if (!token) return false;
        const [device] = await this.db.select({ id: schema.trustedDevices.id })
            .from(schema.trustedDevices)
            .where(and(
                eq(schema.trustedDevices.userId, userId),
                eq(schema.trustedDevices.tokenHash, this.security.hashOpaqueToken(token)),
                gt(schema.trustedDevices.expiresAt, new Date()),
            ));
        return Boolean(device);
    }

    /** 사용자 행을 잠근 로그인 트랜잭션에서 최종 확인해 설정 변경과 세션 발급 사이의 경합을 닫는다. */
    async assertLoginAuthorized(
        userId: number,
        authorization: LoginMfaAuthorization,
        tx: SessionTransaction,
    ): Promise<void> {
        const [setting] = await tx.select({ method: schema.mfaSettings.method })
            .from(schema.mfaSettings)
            .where(eq(schema.mfaSettings.userId, userId));
        if (!setting) return;

        if (authorization.kind === 'verified' && authorization.method === setting.method) return;
        if (authorization.kind === 'trusted-device') {
            const now = new Date();
            const [trusted] = await tx.update(schema.trustedDevices).set({ lastUsedAt: now }).where(and(
                eq(schema.trustedDevices.userId, userId),
                eq(schema.trustedDevices.tokenHash, this.security.hashOpaqueToken(authorization.token)),
                gt(schema.trustedDevices.expiresAt, now),
            )).returning({ id: schema.trustedDevices.id });
            if (trusted) return;
        }
        throw new UnauthorizedException({ code: 'MFA_LOGIN_RETRY', message: 'Login security state changed; retry login' });
    }

    async beginLoginChallenge(userId: number, securityEpoch: number, method: MfaMethod) {
        const challengeToken = this.security.createLoginChallengeToken(userId);
        const state: LoginChallengeState = { userId, securityEpoch, method };
        const key = this.loginChallengeKey(challengeToken);
        await this.redis.set(key, JSON.stringify(state), LOGIN_CHALLENGE_TTL_SECONDS);
        try {
            if (method === 'email') {
                await this.sendEmailFactorCode(userId, MFA_EMAIL_PURPOSE.LOGIN, method);
            }
        } catch (error) {
            await this.redis.del(key).catch(() => undefined);
            throw error;
        }
        return {
            mfaRequired: true as const,
            challengeToken,
            method,
            expiresIn: LOGIN_CHALLENGE_TTL_SECONDS,
        };
    }

    async resendLoginEmail(challengeToken: string): Promise<{ sent: true }> {
        const state = await this.readLoginChallenge(challengeToken);
        if (state.method !== 'email') throw invalidFactor();
        await this.sendEmailFactorCode(state.userId, MFA_EMAIL_PURPOSE.LOGIN, 'email');
        return { sent: true };
    }

    async completeLoginChallenge(challengeToken: string, code: string): Promise<CompletedLoginChallenge> {
        const key = this.loginChallengeKey(challengeToken);
        const raw = await this.redis.get(key);
        if (!raw) throw new UnauthorizedException({ code: 'INVALID_MFA_CHALLENGE', message: 'Invalid or expired login challenge' });
        const state = this.parseLoginChallenge(raw);
        const claimId = randomUUID();
        const claimKey = `${key}:claim`;
        const remainingTtlMs = await this.redis.compareAndClaim(
            key,
            raw,
            claimKey,
            claimId,
            LOGIN_CHALLENGE_CLAIM_TTL_SECONDS,
        );
        if (remainingTtlMs <= 0) {
            throw new UnauthorizedException({ code: 'INVALID_MFA_CHALLENGE', message: 'Invalid or expired login challenge' });
        }

        try {
            const authorization = await this.verifyFactor(
                state.userId,
                code,
                MFA_EMAIL_PURPOSE.LOGIN,
                state.method,
            );
            if (authorization.method !== state.method) throw invalidFactor();
            await this.redis.compareAndDelete(claimKey, claimId);
            return state;
        } catch (error) {
            await this.redis.releaseClaim(claimKey, claimId, key, raw, remainingTtlMs).catch(() => undefined);
            throw error;
        }
    }

    async sendStepUpEmail(userId: number): Promise<{ sent: true }> {
        await this.sendEmailFactorCode(userId, MFA_EMAIL_PURPOSE.STEP_UP, 'email');
        return { sent: true };
    }

    async authorizeStepUp(userId: number, code: string): Promise<MfaAuthorization> {
        const method = await this.getMethod(userId);
        if (!method) throw new ConflictException({ code: 'MFA_NOT_ENABLED', message: 'Two-factor authentication is not enabled' });
        return this.verifyFactor(userId, code, MFA_EMAIL_PURPOSE.STEP_UP, method);
    }

    /** 비밀번호 재설정의 메일 코드는 OTP 사용자의 2차 수단으로 인정하지 않는다. */
    async authorizePasswordReset(userId: number, code?: string): Promise<MfaAuthorization> {
        const method = await this.getMethod(userId);
        if (!method) return { kind: 'not-enabled' };
        if (!code) {
            if (method === 'email') {
                await this.sendEmailFactorCode(userId, MFA_EMAIL_PURPOSE.RESET_PASSWORD, 'email');
            }
            throw mfaRequired();
        }
        return this.verifyFactor(userId, code, MFA_EMAIL_PURPOSE.RESET_PASSWORD, method);
    }

    /** 메일 방식은 필수 탈퇴 메일 코드가 곧 선택한 2차 수단이다. TOTP 방식만 별도 코드를 요구한다. */
    async authorizeAccountDeletion(userId: number, secondFactorCode?: string): Promise<MfaAuthorization> {
        const method = await this.getMethod(userId);
        if (!method) return { kind: 'not-enabled' };
        if (method === 'email') return { kind: 'verified', method };
        if (!secondFactorCode) throw mfaRequired();
        return this.verifyFactor(userId, secondFactorCode, MFA_EMAIL_PURPOSE.STEP_UP, method);
    }

    /** 재설정/탈퇴 트랜잭션 안에서 수단이 바뀌지 않았는지 다시 본다. */
    async assertAccountAuthorizationCurrent(
        tx: SessionTransaction,
        userId: number,
        authorization: MfaAuthorization,
    ): Promise<void> {
        const [setting] = await tx.select({ method: schema.mfaSettings.method })
            .from(schema.mfaSettings)
            .where(eq(schema.mfaSettings.userId, userId));
        if (!setting) {
            if (authorization.kind === 'not-enabled') return;
            // 이미 올바른 수단을 소비한 직후 다른 요청이 MFA를 껐다면 허용해도 우회는 아니다.
            if (authorization.kind === 'verified') return;
        }
        if (setting && authorization.kind === 'verified' && authorization.method === setting.method) return;
        throw mfaRequired();
    }

    async enableEmail(userId: number, currentPassword: string, audit: AuditContext) {
        const authority = await this.assertCurrentPassword(userId, currentPassword);
        const backupSet = await this.createBackupSet(userId);
        await this.db.transaction(async (tx) => {
            await this.assertUserUnchangedAndMfaDisabled(tx, userId, authority);
            await tx.insert(schema.mfaSettings).values({ userId, method: 'email' });
            await tx.insert(schema.mfaBackupCodes).values(backupSet.rows);
            await tx.insert(schema.adminAuditLog).values({
                actor: `user:${userId}`,
                action: 'MFA_ENABLED',
                targetType: 'user',
                targetId: String(userId),
                reason: 'User enabled email multi-factor authentication',
                ...audit,
            });
        });
        return { enabled: true as const, method: 'email' as const, backupCodes: backupSet.plain };
    }

    async startTotpSetup(userId: number, currentPassword: string) {
        const authority = await this.assertCurrentPassword(userId, currentPassword);
        const existing = await this.getMethod(userId);
        if (existing) throw new ConflictException({ code: 'MFA_ALREADY_ENABLED', message: 'Two-factor authentication is already enabled' });

        const secret = this.security.generateTotpSecret();
        const setupToken = this.security.newOpaqueToken();
        const state: TotpSetupState = {
            setupToken,
            encryptedSecret: this.security.encryptTotpSecret(secret),
            securityEpoch: authority.securityEpoch,
        };
        await this.redis.set(this.totpSetupKey(userId), JSON.stringify(state), TOTP_SETUP_TTL_SECONDS);
        return {
            setupToken,
            secret,
            otpauthUri: `otpauth://totp/swITch:${encodeURIComponent(authority.email)}?secret=${secret}&issuer=swITch&algorithm=SHA1&digits=6&period=30`,
            expiresIn: TOTP_SETUP_TTL_SECONDS,
        };
    }

    async confirmTotpSetup(userId: number, setupToken: string, code: string, audit: AuditContext) {
        const key = this.totpSetupKey(userId);
        const raw = await this.redis.get(key);
        if (!raw) throw new UnauthorizedException({ code: 'INVALID_TOTP_SETUP', message: 'Invalid or expired TOTP setup' });
        const state = this.parseTotpSetup(raw);
        if (state.setupToken !== setupToken) throw new UnauthorizedException({ code: 'INVALID_TOTP_SETUP', message: 'Invalid or expired TOTP setup' });

        const secret = this.security.decryptTotpSecret(state.encryptedSecret);
        const matchedStep = matchingTotpStep(secret, code);
        if (matchedStep === null) throw invalidFactor();
        const backupSet = await this.createBackupSet(userId);

        await this.db.transaction(async (tx) => {
            const [user] = await tx.select({
                status: schema.users.accountStatus,
                securityEpoch: schema.users.securityEpoch,
            }).from(schema.users).where(eq(schema.users.id, userId)).for('update');
            if (!user || user.status !== 'ACTIVE' || user.securityEpoch !== state.securityEpoch) {
                throw new UnauthorizedException({ code: 'TOTP_SETUP_RETRY', message: 'Account security changed; start setup again' });
            }
            const [existing] = await tx.select({ userId: schema.mfaSettings.userId })
                .from(schema.mfaSettings)
                .where(eq(schema.mfaSettings.userId, userId));
            if (existing) throw new ConflictException({ code: 'MFA_ALREADY_ENABLED', message: 'Two-factor authentication is already enabled' });
            await tx.insert(schema.mfaSettings).values({
                userId,
                method: 'totp',
                totpSecretEncrypted: state.encryptedSecret,
                lastTotpStep: matchedStep,
            });
            await tx.insert(schema.mfaBackupCodes).values(backupSet.rows);
            await tx.insert(schema.adminAuditLog).values({
                actor: `user:${userId}`,
                action: 'MFA_ENABLED',
                targetType: 'user',
                targetId: String(userId),
                reason: 'User enabled TOTP multi-factor authentication',
                ...audit,
            });
        });
        await this.redis.compareAndDelete(key, raw);
        return { enabled: true as const, method: 'totp' as const, backupCodes: backupSet.plain };
    }

    async disable(userId: number, code: string, audit: AuditContext): Promise<{ disabled: true }> {
        const authorization = await this.authorizeStepUp(userId, code);
        await this.db.transaction(async (tx) => {
            await this.assertAuthorizationCurrent(tx, userId, authorization);
            await tx.delete(schema.trustedDevices).where(eq(schema.trustedDevices.userId, userId));
            await tx.delete(schema.mfaBackupCodes).where(eq(schema.mfaBackupCodes.userId, userId));
            await tx.delete(schema.mfaSettings).where(eq(schema.mfaSettings.userId, userId));
            await tx.insert(schema.adminAuditLog).values({
                actor: `user:${userId}`,
                action: 'MFA_DISABLED',
                targetType: 'user',
                targetId: String(userId),
                reason: 'User disabled multi-factor authentication after second-factor verification',
                ...audit,
            });
        });
        await this.clearEphemeralState(userId).catch(() => undefined);
        return { disabled: true };
    }

    async regenerateBackupCodes(userId: number, code: string, audit: AuditContext) {
        const authorization = await this.authorizeStepUp(userId, code);
        const backupSet = await this.createBackupSet(userId);
        await this.db.transaction(async (tx) => {
            await this.assertAuthorizationCurrent(tx, userId, authorization);
            await tx.delete(schema.mfaBackupCodes).where(eq(schema.mfaBackupCodes.userId, userId));
            await tx.insert(schema.mfaBackupCodes).values(backupSet.rows);
            await tx.insert(schema.adminAuditLog).values({
                actor: `user:${userId}`,
                action: 'MFA_BACKUP_CODES_REGENERATED',
                targetType: 'user',
                targetId: String(userId),
                reason: 'User replaced all backup codes after second-factor verification',
                ...audit,
            });
        });
        return { backupCodes: backupSet.plain, backupCodesRemaining: backupSet.plain.length };
    }

    async registerTrustedDevice(
        userId: number,
        userAgent: string | undefined,
        tx: SessionTransaction,
    ): Promise<{ token: string; expiresAt: Date }> {
        const token = this.security.newOpaqueToken();
        const expiresAt = new Date(Date.now() + this.trustedDeviceDays * 24 * 60 * 60 * 1000);
        await tx.delete(schema.trustedDevices).where(and(
            eq(schema.trustedDevices.userId, userId),
            lte(schema.trustedDevices.expiresAt, new Date()),
        ));
        const [device] = await tx.insert(schema.trustedDevices).values({
            userId,
            tokenHash: this.security.hashOpaqueToken(token),
            deviceLabel: this.sessionSecurity.deviceLabel(userAgent),
            expiresAt,
        }).returning({ id: schema.trustedDevices.id });
        await tx.insert(schema.adminAuditLog).values({
            actor: `user:${userId}`,
            action: 'MFA_TRUSTED_DEVICE_ADDED',
            targetType: 'trusted-device',
            targetId: device!.id,
            reason: 'User trusted this device after login second-factor verification',
            ...auditContext({ expiresAt: expiresAt.toISOString() }),
        });
        return { token, expiresAt };
    }

    async listTrustedDevices(userId: number, currentToken?: string) {
        const now = new Date();
        const currentHash = currentToken ? this.security.hashOpaqueToken(currentToken) : null;
        await this.db.delete(schema.trustedDevices).where(and(
            eq(schema.trustedDevices.userId, userId),
            lte(schema.trustedDevices.expiresAt, now),
        ));
        const rows = await this.db.select({
            id: schema.trustedDevices.id,
            tokenHash: schema.trustedDevices.tokenHash,
            deviceLabel: schema.trustedDevices.deviceLabel,
            createdAt: schema.trustedDevices.createdAt,
            lastUsedAt: schema.trustedDevices.lastUsedAt,
            expiresAt: schema.trustedDevices.expiresAt,
        }).from(schema.trustedDevices).where(and(
            eq(schema.trustedDevices.userId, userId),
            gt(schema.trustedDevices.expiresAt, now),
        )).orderBy(desc(schema.trustedDevices.lastUsedAt));
        return rows.map(({ tokenHash, ...row }) => ({ ...row, current: tokenHash === currentHash }));
    }

    async revokeTrustedDevice(
        userId: number,
        deviceId: string,
        code: string,
        currentToken: string | undefined,
        audit: AuditContext,
    ) {
        const authorization = await this.authorizeStepUp(userId, code);
        const currentHash = currentToken ? this.security.hashOpaqueToken(currentToken) : null;
        return this.db.transaction(async (tx) => {
            await this.assertAuthorizationCurrent(tx, userId, authorization);
            const [removed] = await tx.delete(schema.trustedDevices).where(and(
                eq(schema.trustedDevices.id, deviceId),
                eq(schema.trustedDevices.userId, userId),
            )).returning({ id: schema.trustedDevices.id, tokenHash: schema.trustedDevices.tokenHash });
            if (!removed) throw new NotFoundException('Trusted device not found');
            await tx.insert(schema.adminAuditLog).values({
                actor: `user:${userId}`,
                action: 'MFA_TRUSTED_DEVICE_REVOKED',
                targetType: 'trusted-device',
                targetId: deviceId,
                reason: 'User revoked a trusted device after second-factor verification',
                ...audit,
            });
            return { revoked: true as const, current: removed.tokenHash === currentHash };
        });
    }

    async clearEphemeralState(userId: number): Promise<void> {
        await this.redis.del(this.totpSetupKey(userId));
    }

    private async verifyFactor(
        userId: number,
        suppliedCode: string,
        emailPurpose: VerificationPurpose,
        expectedMethod: MfaMethod,
    ): Promise<{ kind: 'verified'; method: MfaMethod }> {
        const [setting] = await this.db.select({
            method: schema.mfaSettings.method,
            encryptedSecret: schema.mfaSettings.totpSecretEncrypted,
        }).from(schema.mfaSettings).where(eq(schema.mfaSettings.userId, userId));
        if (!setting || setting.method !== expectedMethod) throw invalidFactor();

        const normalizedBackup = suppliedCode.trim().toUpperCase();
        if (BACKUP_CODE_PATTERN.test(normalizedBackup)) {
            await this.consumeBackupCode(userId, normalizedBackup);
            return { kind: 'verified', method: setting.method };
        }

        if (setting.method === 'email') {
            const [user] = await this.db.select({ email: schema.users.email, status: schema.users.accountStatus })
                .from(schema.users)
                .where(eq(schema.users.id, userId));
            if (!user || user.status !== 'ACTIVE') throw invalidFactor();
            const claim = await claimVerificationCode(this.redis, emailPurpose, user.email, suppliedCode);
            if (!claim) throw invalidFactor();
            await commitVerificationCodeClaim(this.redis, claim);
            return { kind: 'verified', method: setting.method };
        }

        if (!setting.encryptedSecret) throw invalidFactor();
        const secret = this.security.decryptTotpSecret(setting.encryptedSecret);
        const step = matchingTotpStep(secret, suppliedCode);
        if (step === null) throw invalidFactor();
        const [consumed] = await this.db.update(schema.mfaSettings).set({
            lastTotpStep: step,
            // 직전 키로 읽은 행도 성공 시 현재 키로 자연스럽게 재암호화된다.
            totpSecretEncrypted: this.security.encryptTotpSecret(secret),
            updatedAt: new Date(),
        }).where(and(
            eq(schema.mfaSettings.userId, userId),
            eq(schema.mfaSettings.method, 'totp'),
            or(isNull(schema.mfaSettings.lastTotpStep), lt(schema.mfaSettings.lastTotpStep, step)),
        )).returning({ userId: schema.mfaSettings.userId });
        if (!consumed) throw invalidFactor();
        return { kind: 'verified', method: setting.method };
    }

    private async consumeBackupCode(userId: number, normalizedCode: string): Promise<void> {
        const codeId = normalizedCode.slice(0, 8);
        const [row] = await this.db.select({
            id: schema.mfaBackupCodes.id,
            codeHash: schema.mfaBackupCodes.codeHash,
        }).from(schema.mfaBackupCodes).where(and(
            eq(schema.mfaBackupCodes.userId, userId),
            eq(schema.mfaBackupCodes.codeId, codeId),
            isNull(schema.mfaBackupCodes.usedAt),
        ));
        if (!row || !await bcrypt.compare(normalizedCode, row.codeHash)) throw invalidFactor();
        const [consumed] = await this.db.update(schema.mfaBackupCodes).set({ usedAt: new Date() }).where(and(
            eq(schema.mfaBackupCodes.id, row.id),
            eq(schema.mfaBackupCodes.userId, userId),
            isNull(schema.mfaBackupCodes.usedAt),
        )).returning({ id: schema.mfaBackupCodes.id });
        if (!consumed) throw invalidFactor();
    }

    private async sendEmailFactorCode(
        userId: number,
        purpose: VerificationPurpose,
        expectedMethod: MfaMethod,
    ): Promise<void> {
        const [row] = await this.db.select({
            email: schema.users.email,
            status: schema.users.accountStatus,
            method: schema.mfaSettings.method,
        }).from(schema.users).innerJoin(
            schema.mfaSettings,
            eq(schema.mfaSettings.userId, schema.users.id),
        ).where(eq(schema.users.id, userId));
        if (!row || row.status !== 'ACTIVE' || row.method !== expectedMethod || row.method !== 'email') throw invalidFactor();
        const code = await issueVerificationCode(this.redis, purpose, row.email);
        if (code !== null && !await this.email.sendMfaCodeEmail(row.email, code)) {
            throw new InternalServerErrorException('Verification email send failed');
        }
    }

    private async assertCurrentPassword(userId: number, currentPassword: string) {
        const [user] = await this.db.select({
            email: schema.users.email,
            passwordHash: schema.users.passwordHash,
            status: schema.users.accountStatus,
            securityEpoch: schema.users.securityEpoch,
        }).from(schema.users).where(eq(schema.users.id, userId));
        if (!user || user.status !== 'ACTIVE') throw new NotFoundException('User not found');
        if (!await bcrypt.compare(currentPassword, user.passwordHash)) {
            throw new UnauthorizedException({ code: 'CURRENT_PASSWORD_INCORRECT', message: 'Current password is incorrect' });
        }
        return user;
    }

    private async assertUserUnchangedAndMfaDisabled(
        tx: SessionTransaction,
        userId: number,
        authority: { passwordHash: string; securityEpoch: number },
    ): Promise<void> {
        const [user] = await tx.select({
            passwordHash: schema.users.passwordHash,
            status: schema.users.accountStatus,
            securityEpoch: schema.users.securityEpoch,
        }).from(schema.users).where(eq(schema.users.id, userId)).for('update');
        if (!user || user.status !== 'ACTIVE' || user.passwordHash !== authority.passwordHash || user.securityEpoch !== authority.securityEpoch) {
            throw new UnauthorizedException({ code: 'MFA_ENABLE_RETRY', message: 'Account security changed; retry' });
        }
        const [setting] = await tx.select({ userId: schema.mfaSettings.userId })
            .from(schema.mfaSettings)
            .where(eq(schema.mfaSettings.userId, userId));
        if (setting) throw new ConflictException({ code: 'MFA_ALREADY_ENABLED', message: 'Two-factor authentication is already enabled' });
    }

    private async assertAuthorizationCurrent(
        tx: SessionTransaction,
        userId: number,
        authorization: MfaAuthorization,
    ): Promise<void> {
        const [user] = await tx.select({ status: schema.users.accountStatus })
            .from(schema.users).where(eq(schema.users.id, userId)).for('update');
        if (!user || user.status !== 'ACTIVE') throw new NotFoundException('User not found');
        const [setting] = await tx.select({ method: schema.mfaSettings.method })
            .from(schema.mfaSettings)
            .where(eq(schema.mfaSettings.userId, userId));
        if (!setting || authorization.kind !== 'verified' || authorization.method !== setting.method) {
            throw mfaRequired();
        }
    }

    private async createBackupSet(userId: number): Promise<{ plain: string[]; rows: BackupCodeRow[] }> {
        const plain: string[] = [];
        const rows: BackupCodeRow[] = [];
        const ids = new Set<string>();
        while (plain.length < BACKUP_CODE_COUNT) {
            const codeId = randomBytes(4).toString('hex').toUpperCase();
            if (ids.has(codeId)) continue;
            ids.add(codeId);
            const secret = backupSecret(16);
            const formattedSecret = secret.match(/.{4}/g)!.join('-');
            const code = `${codeId}-${formattedSecret}`;
            plain.push(code);
            rows.push({
                userId,
                codeId,
                codeHash: await bcrypt.hash(code, BACKUP_CODE_BCRYPT_ROUNDS),
            });
        }
        return { plain, rows };
    }

    private async readLoginChallenge(challengeToken: string): Promise<LoginChallengeState> {
        const raw = await this.redis.get(this.loginChallengeKey(challengeToken));
        if (!raw) throw new UnauthorizedException({ code: 'INVALID_MFA_CHALLENGE', message: 'Invalid or expired login challenge' });
        return this.parseLoginChallenge(raw);
    }

    private parseLoginChallenge(raw: string): LoginChallengeState {
        try {
            const state = JSON.parse(raw) as Partial<LoginChallengeState>;
            if (!Number.isInteger(state.userId) || !Number.isInteger(state.securityEpoch)
                || (state.method !== 'email' && state.method !== 'totp')) throw new Error('invalid');
            return state as LoginChallengeState;
        } catch {
            throw new UnauthorizedException({ code: 'INVALID_MFA_CHALLENGE', message: 'Invalid or expired login challenge' });
        }
    }

    private parseTotpSetup(raw: string): TotpSetupState {
        try {
            const state = JSON.parse(raw) as Partial<TotpSetupState>;
            if (typeof state.setupToken !== 'string' || typeof state.encryptedSecret !== 'string'
                || !Number.isInteger(state.securityEpoch)) throw new Error('invalid');
            return state as TotpSetupState;
        } catch {
            throw new UnauthorizedException({ code: 'INVALID_TOTP_SETUP', message: 'Invalid or expired TOTP setup' });
        }
    }

    private loginChallengeKey(challengeToken: string): string {
        return `auth:mfa-login-challenge:${challengeToken}`;
    }

    private totpSetupKey(userId: number): string {
        return `auth:mfa-totp-setup:${userId}`;
    }
}
