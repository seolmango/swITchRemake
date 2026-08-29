import {
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, gt, isNotNull, isNull, lt, ne } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';

@Injectable()
export class SessionService implements OnModuleInit, OnModuleDestroy {
    private readonly ipRetentionDays: number;
    private readonly logger = new Logger(SessionService.name);
    private cleanupTimer?: NodeJS.Timeout;

    constructor(
        @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
        configService: ConfigService,
    ) {
        this.ipRetentionDays = Number(configService.get<string>('SESSION_IP_RETENTION_DAYS', '7'));
        if (!Number.isInteger(this.ipRetentionDays) || this.ipRetentionDays < 1) {
            throw new Error('SESSION_IP_RETENTION_DAYS must be a positive integer');
        }
    }

    onModuleInit(): void {
        void this.runIpCleanup();
        this.cleanupTimer = setInterval(() => void this.runIpCleanup(), 60 * 60 * 1000);
        this.cleanupTimer.unref();
    }

    onModuleDestroy(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
    }

    async list(userId: number, currentSessionId: string) {
        const now = new Date();
        await this.purgeExpiredEncryptedIps(now);

        const rows = await this.db.select({
            id: schema.sessions.id,
            deviceLabel: schema.sessions.deviceLabel,
            createdAt: schema.sessions.createdAt,
            lastUsedAt: schema.sessions.lastUsedAt,
            expiresAt: schema.sessions.expiresAt,
        }).from(schema.sessions).where(and(
            eq(schema.sessions.userId, userId),
            isNull(schema.sessions.revokedAt),
            gt(schema.sessions.expiresAt, now),
        )).orderBy(desc(schema.sessions.lastUsedAt));

        return rows.map((row) => ({
            ...row,
            current: row.id === currentSessionId,
        }));
    }

    async revoke(userId: number, sessionId: string): Promise<void> {
        const now = new Date();
        const [revoked] = await this.db.update(schema.sessions).set({
            revokedAt: now,
        }).where(and(
            eq(schema.sessions.id, sessionId),
            eq(schema.sessions.userId, userId),
            isNull(schema.sessions.revokedAt),
            gt(schema.sessions.expiresAt, now),
        )).returning({ id: schema.sessions.id });

        if (!revoked) {
            throw new NotFoundException('Session not found');
        }
    }

    async revokeCurrent(userId: number, sessionId: string): Promise<void> {
        await this.db.update(schema.sessions).set({ revokedAt: new Date() }).where(and(
            eq(schema.sessions.id, sessionId),
            eq(schema.sessions.userId, userId),
            isNull(schema.sessions.revokedAt),
        ));
    }

    async revokeOthers(userId: number, currentSessionId: string): Promise<number> {
        const revoked = await this.db.update(schema.sessions).set({
            revokedAt: new Date(),
        }).where(and(
            eq(schema.sessions.userId, userId),
            ne(schema.sessions.id, currentSessionId),
            isNull(schema.sessions.revokedAt),
        )).returning({ id: schema.sessions.id });

        return revoked.length;
    }

    /**
     * 이 계정의 살아 있는 세션을 전부 끊는다.
     *
     * 비밀번호 재설정이 쓴다. 되찾는 상황은 대개 남이 들어와 있을지도 모르는 상황이라,
     * 남의 세션을 살려 두면 비밀번호만 바뀌고 접근은 그대로 남는다.
     */
    async revokeAll(userId: number): Promise<number> {
        const revoked = await this.db.update(schema.sessions).set({
            revokedAt: new Date(),
        }).where(and(
            eq(schema.sessions.userId, userId),
            isNull(schema.sessions.revokedAt),
        )).returning({ id: schema.sessions.id });

        return revoked.length;
    }

    async assertOwnedActiveSession(userId: number, sessionId: string): Promise<void> {
        const [session] = await this.db.select({ id: schema.sessions.id })
            .from(schema.sessions)
            .where(and(
                eq(schema.sessions.id, sessionId),
                eq(schema.sessions.userId, userId),
                isNull(schema.sessions.revokedAt),
                gt(schema.sessions.expiresAt, new Date()),
            ));
        if (!session) {
            throw new ForbiddenException('Current session is no longer active');
        }
    }

    async purgeExpiredEncryptedIps(now = new Date()): Promise<void> {
        const cutoff = new Date(now.getTime() - this.ipRetentionDays * 24 * 60 * 60 * 1000);
        await this.db.update(schema.sessions).set({ ipEncrypted: null }).where(and(
            isNotNull(schema.sessions.ipEncrypted),
            lt(schema.sessions.createdAt, cutoff),
        ));
    }

    private async runIpCleanup(): Promise<void> {
        try {
            await this.purgeExpiredEncryptedIps();
        } catch (error) {
            this.logger.error('Failed to purge expired encrypted session IPs', error);
        }
    }
}
