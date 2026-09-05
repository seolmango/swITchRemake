import {
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { and, eq, gt, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';
import { auditContext, type AuditContext } from '../admin/audit-log';
import type { MfaAuthorization } from '../mfa/mfa.types';
import { SessionSecurityService } from '../session/session-security.service';

type SanctionType = typeof schema.sanctionTypeEnum.enumValues[number];
type AccountStatus = typeof schema.accountStatusEnum.enumValues[number];
const RECONCILIATION_CONCURRENCY = 8;

/** 트랜잭션 핸들. drizzle의 콜백 인자와 같은 모양이면 된다. */
type SanctionTransaction = Parameters<Parameters<PostgresJsDatabase<typeof schema>['transaction']>[0]>[0];

export interface ApplySanctionInput {
    userId: number;
    type: SanctionType;
    scope: string;
    startsAt?: Date;
    expiresAt?: Date | null;
    reason: string;
    evidenceMatchId?: string | null;
    actor: string;
    audit?: AuditContext;
}

@Injectable()
export class SanctionService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SanctionService.name);
    private reconciliationTimer?: NodeJS.Timeout;

    constructor(
        @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
        private readonly security: SessionSecurityService,
    ) {}

    /** 탈퇴한 제재 대상의 주소와 같은지 대조한다. 원문 주소는 DB로 보내지 않는다. */
    async isEmailRegistrationBlocked(email: string, now = new Date()): Promise<boolean> {
        const emailHmac = this.security.hmacEmail(email);
        const [sanction] = await this.db.select({ id: schema.sanctions.id })
            .from(schema.sanctions)
            .leftJoin(
                schema.sanctionRevocations,
                eq(schema.sanctionRevocations.sanctionId, schema.sanctions.id),
            )
            .where(and(
                eq(schema.sanctions.emailHmac, emailHmac),
                isNull(schema.sanctionRevocations.sanctionId),
                or(
                    gt(schema.sanctions.expiresAt, now),
                    and(eq(schema.sanctions.type, 'BAN'), isNull(schema.sanctions.expiresAt)),
                ),
            ))
            .limit(1);
        return sanction !== undefined;
    }

    onModuleInit(): void {
        void this.runScheduledReconciliation();
        this.reconciliationTimer = setInterval(
            () => void this.runScheduledReconciliation(),
            60 * 1000,
        );
        this.reconciliationTimer.unref();
    }

    onModuleDestroy(): void {
        if (this.reconciliationTimer) {
            clearInterval(this.reconciliationTimer);
        }
    }

    /**
     * 이 계정이 지금 경기 제한을 받고 있는가.
     *
     * BAN과 달리 계정 상태 컬럼을 바꾸지 않는다 - 로그인은 되고 경기만 막는 처분이라, 상태로
     * 표현하면 밴과 구분이 사라진다. 그래서 판정할 때마다 활성 제재를 본다.
     *
     * 예전에는 이 타입이 `sanctions` 행으로 저장되기만 하고 **아무 데서도 읽히지 않았다.**
     * 운영자는 제한을 걸었다고 믿고 대상은 그대로 놀았다.
     */
    async isGameRestricted(userId: number, now = new Date()): Promise<boolean> {
        const [restriction] = await this.db.select({ id: schema.sanctions.id })
            .from(schema.sanctions)
            .leftJoin(
                schema.sanctionRevocations,
                eq(schema.sanctionRevocations.sanctionId, schema.sanctions.id),
            )
            .where(and(
                eq(schema.sanctions.userId, userId),
                eq(schema.sanctions.type, 'GAME_RESTRICT'),
                lte(schema.sanctions.startsAt, now),
                or(isNull(schema.sanctions.expiresAt), gt(schema.sanctions.expiresAt, now)),
                isNull(schema.sanctionRevocations.sanctionId),
            ))
            .limit(1);
        return restriction !== undefined;
    }

    /**
     * 제재를 건다.
     *
     * `tx`를 주면 **부르는 쪽의 트랜잭션 안에서** 돈다. 신고 사건에서 제재를 걸 때가 그렇다 —
     * 따로 돌면 제재만 커밋되고 사건은 그대로 남는 경우가 생기고, 그때 남는 것은 "밴은 됐는데
     * 아무도 처리했다고 기록하지 않은" 상태다. 부르는 쪽이 없으면 예전처럼 스스로 연다.
     */
    async apply(input: ApplySanctionInput, tx?: SanctionTransaction) {
        const now = new Date();
        const startsAt = input.startsAt ?? now;
        const expiresAt = input.expiresAt ?? null;
        if (expiresAt && expiresAt <= startsAt) {
            throw new ConflictException('Sanction expiration must be after its start');
        }

        const run = async (tx: SanctionTransaction) => {
            const [user] = await tx.select({
                id: schema.users.id,
                status: schema.users.accountStatus,
            })
                .from(schema.users)
                .where(eq(schema.users.id, input.userId))
                .for('update');
            if (!user) {
                throw new NotFoundException('User not found');
            }
            if (user.status === 'DELETED') {
                throw new ConflictException('Deleted accounts cannot be sanctioned');
            }

            const [sanction] = await tx.insert(schema.sanctions).values({
                userId: input.userId,
                type: input.type,
                scope: input.scope,
                startsAt,
                expiresAt,
                reason: input.reason,
                evidenceMatchId: input.evidenceMatchId ?? null,
                createdBy: input.actor,
            }).returning();

            const immediatelyBanned = input.type === 'BAN'
                && startsAt <= now
                && (!expiresAt || expiresAt > now);
            if (immediatelyBanned) {
                await tx.update(schema.users).set({
                    accountStatus: 'BANNED',
                    updatedAt: now,
                }).where(eq(schema.users.id, input.userId));
                await tx.delete(schema.sessions).where(eq(schema.sessions.userId, input.userId));
            }

            const audit = input.audit ?? auditContext();
            await tx.insert(schema.adminAuditLog).values({
                actor: input.actor,
                action: 'SANCTION_CREATED',
                targetType: 'sanction',
                targetId: sanction.id,
                reason: input.reason,
                ...audit,
            });

            return sanction;
        };

        return tx ? run(tx) : this.db.transaction(run);
    }

    async revoke(
        sanctionId: string,
        actor: string,
        reason: string,
        audit: AuditContext = auditContext(),
    ): Promise<void> {
        await this.db.transaction(async (tx) => {
            const [sanction] = await tx.select()
                .from(schema.sanctions)
                .where(eq(schema.sanctions.id, sanctionId))
                .for('update');
            if (!sanction) {
                throw new NotFoundException('Sanction not found');
            }
            /*
             * 사용자 행을 apply()와 **같은 순서로** 잠근다.
             *
             * 예전에는 제재 행만 잠갔다. 그래서 새 BAN 적용과 옛 BAN 취소가 겹치면, 취소 쪽의
             * "다른 활성 BAN이 있나" 조회가 아직 커밋되지 않은 새 BAN을 못 보고 계정을 ACTIVE로
             * 되돌렸다. 1분 뒤 조정 루프가 고치지만 그 사이에는 밴당한 사람이 로그인한다.
             */
            await tx.select({ id: schema.users.id })
                .from(schema.users)
                .where(eq(schema.users.id, sanction.userId))
                .for('update');

            const [existingRevocation] = await tx.select({ sanctionId: schema.sanctionRevocations.sanctionId })
                .from(schema.sanctionRevocations)
                .where(eq(schema.sanctionRevocations.sanctionId, sanctionId));
            if (existingRevocation) {
                throw new ConflictException('Sanction is already revoked');
            }

            await tx.insert(schema.sanctionRevocations).values({
                sanctionId,
                revokedBy: actor,
                reason,
            });

            const now = new Date();
            if (sanction.type === 'BAN') {
                const [otherActiveBan] = await tx.select({ id: schema.sanctions.id })
                    .from(schema.sanctions)
                    .leftJoin(
                        schema.sanctionRevocations,
                        eq(schema.sanctionRevocations.sanctionId, schema.sanctions.id),
                    )
                    .where(and(
                        eq(schema.sanctions.userId, sanction.userId),
                        eq(schema.sanctions.type, 'BAN'),
                        ne(schema.sanctions.id, sanctionId),
                        lte(schema.sanctions.startsAt, now),
                        or(isNull(schema.sanctions.expiresAt), gt(schema.sanctions.expiresAt, now)),
                        isNull(schema.sanctionRevocations.sanctionId),
                    ))
                    .limit(1);

                if (!otherActiveBan) {
                    await tx.update(schema.users).set({
                        accountStatus: 'ACTIVE',
                        updatedAt: now,
                    }).where(and(
                        eq(schema.users.id, sanction.userId),
                        eq(schema.users.accountStatus, 'BANNED'),
                    ));
                }
            }

            await tx.insert(schema.adminAuditLog).values({
                actor,
                action: 'SANCTION_REVOKED',
                targetType: 'sanction',
                targetId: sanctionId,
                reason,
                ...audit,
            });
        });
    }

    async deleteAccount(
        userId: number,
        actor: string,
        reason: string,
        audit: AuditContext = auditContext(),
        mfaAuthorization: MfaAuthorization = { kind: 'not-enabled' },
    ): Promise<void> {
        await this.db.transaction(async (tx) => {
            const [user] = await tx.select({
                status: schema.users.accountStatus,
                email: schema.users.email,
            })
                .from(schema.users)
                .where(eq(schema.users.id, userId))
                .for('update');
            if (!user) {
                throw new NotFoundException('User not found');
            }
            if (user.status === 'DELETED') {
                throw new NotFoundException('User not found');
            }

            const [mfaSetting] = await tx.select({ method: schema.mfaSettings.method })
                .from(schema.mfaSettings)
                .where(eq(schema.mfaSettings.userId, userId));
            if (mfaSetting) {
                if (mfaAuthorization.kind !== 'verified' || mfaAuthorization.method !== mfaSetting.method) {
                    throw new ForbiddenException({ code: 'MFA_REQUIRED', message: 'A second factor is required' });
                }
            }

            const now = new Date();
            const emailHmac = this.security.hmacEmail(user.email);
            /*
             * HMAC은 제재가 실제로 재가입을 막는 동안에만 붙인다. 기간이 없는 영구 BAN과 아직
             * 끝나지 않은 기간제 제재만 대상이고, 취소된 제재에는 남기지 않는다.
             */
            await tx.execute(sql`
                UPDATE sanctions sanction
                SET email_hmac = ${emailHmac}
                WHERE sanction.user_id = ${userId}
                  AND NOT EXISTS (
                      SELECT 1 FROM sanction_revocations revocation
                      WHERE revocation.sanction_id = sanction.id
                  )
                  AND (
                      sanction.expires_at > ${now.toISOString()}::timestamptz
                      OR (sanction.type = 'BAN' AND sanction.expires_at IS NULL)
                  )
            `);
            // 전적의 당시 닉네임과 결과는 남기되 살아 있는 계정으로 향하는 연결만 끊는다.
            await tx.update(schema.matchParticipants).set({ userId: null })
                .where(eq(schema.matchParticipants.userId, userId));
            const tombstone = randomUUID().replace(/-/g, '').slice(0, 16);
            await tx.update(schema.users).set({
                accountStatus: 'DELETED',
                email: `deleted-${tombstone}@invalid.local`,
                passwordHash: '!deleted!',
                nickname: `Deleted_${tombstone.slice(0, 8)}`,
                role: 'USER',
                stats: {},
                termsVersion: null,
                termsAgreedAt: null,
                privacyVersion: null,
                privacyAgreedAt: null,
                securityEpoch: sql`${schema.users.securityEpoch} + 1`,
                updatedAt: now,
            }).where(eq(schema.users.id, userId));
            // users 행은 감사/제재 FK 때문에 가명 껍데기로 남으므로 ON DELETE CASCADE에 기대지 않는다.
            await tx.delete(schema.trustedDevices).where(eq(schema.trustedDevices.userId, userId));
            await tx.delete(schema.mfaBackupCodes).where(eq(schema.mfaBackupCodes.userId, userId));
            await tx.delete(schema.mfaSettings).where(eq(schema.mfaSettings.userId, userId));
            await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
            await tx.insert(schema.adminAuditLog).values({
                actor,
                action: 'ACCOUNT_DELETED',
                targetType: 'user',
                targetId: String(userId),
                reason,
                ...audit,
            });
        });
    }

    async reconcileLoginStatus(userId: number, cachedStatus: AccountStatus): Promise<AccountStatus> {
        if (cachedStatus !== 'BANNED') {
            return cachedStatus;
        }

        return this.reconcileUserStatus(userId, 'login');
    }

    private async reconcileUserStatus(userId: number, source: string): Promise<AccountStatus> {

        return this.db.transaction(async (tx) => {
            const [user] = await tx.select({ status: schema.users.accountStatus })
                .from(schema.users)
                .where(eq(schema.users.id, userId))
                .for('update');
            if (!user || user.status !== 'BANNED') {
                if (!user || user.status === 'DELETED') {
                    return 'DELETED';
                }
            }

            const now = new Date();
            const [activeBan] = await tx.select({ id: schema.sanctions.id })
                .from(schema.sanctions)
                .leftJoin(
                    schema.sanctionRevocations,
                    eq(schema.sanctionRevocations.sanctionId, schema.sanctions.id),
                )
                .where(and(
                    eq(schema.sanctions.userId, userId),
                    eq(schema.sanctions.type, 'BAN'),
                    lte(schema.sanctions.startsAt, now),
                    or(isNull(schema.sanctions.expiresAt), gt(schema.sanctions.expiresAt, now)),
                    isNull(schema.sanctionRevocations.sanctionId),
                ))
                .limit(1);
            if (activeBan) {
                if (user.status !== 'BANNED') {
                    await tx.update(schema.users).set({
                        accountStatus: 'BANNED',
                        updatedAt: now,
                    }).where(eq(schema.users.id, userId));
                    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
                    await tx.insert(schema.adminAuditLog).values({
                        actor: 'system',
                        action: 'ACCOUNT_STATUS_RECONCILED',
                        targetType: 'user',
                        targetId: String(userId),
                        reason: 'A scheduled ban became active',
                        ...auditContext({ source }),
                    });
                }
                return 'BANNED';
            }

            if (user.status !== 'BANNED') {
                return user.status;
            }

            await tx.update(schema.users).set({
                accountStatus: 'ACTIVE',
                updatedAt: now,
            }).where(eq(schema.users.id, userId));
            await tx.insert(schema.adminAuditLog).values({
                actor: 'system',
                action: 'ACCOUNT_STATUS_RECONCILED',
                targetType: 'user',
                targetId: String(userId),
                reason: 'All bans expired or were revoked',
                ...auditContext({ source }),
            });
            return 'ACTIVE';
        });
    }

    private async runScheduledReconciliation(): Promise<void> {
        try {
            const now = new Date();
            const [cachedBans, activeBanSubjects] = await Promise.all([
                this.db.select({ userId: schema.users.id })
                    .from(schema.users)
                    .where(eq(schema.users.accountStatus, 'BANNED')),
                this.db.selectDistinct({ userId: schema.sanctions.userId })
                    .from(schema.sanctions)
                    .leftJoin(
                        schema.sanctionRevocations,
                        eq(schema.sanctionRevocations.sanctionId, schema.sanctions.id),
                    )
                    .where(and(
                        eq(schema.sanctions.type, 'BAN'),
                        lte(schema.sanctions.startsAt, now),
                        or(isNull(schema.sanctions.expiresAt), gt(schema.sanctions.expiresAt, now)),
                        isNull(schema.sanctionRevocations.sanctionId),
                    )),
            ]);
            const userIds = new Set([
                ...cachedBans.map((row) => row.userId),
                ...activeBanSubjects.map((row) => row.userId),
            ]);
            const pending = [...userIds];
            for (let offset = 0; offset < pending.length; offset += RECONCILIATION_CONCURRENCY) {
                const batch = pending.slice(offset, offset + RECONCILIATION_CONCURRENCY);
                await Promise.all(batch.map(async (userId) => {
                    try {
                        await this.reconcileUserStatus(userId, 'scheduler');
                    } catch (error) {
                        // 한 사용자의 잠금/DB 오류가 뒤 사용자의 만료 해제를 한 회차 전부 막지 않는다.
                        this.logger.error(`Failed to reconcile scheduled sanction for userId=${userId}`, error);
                    }
                }));
            }
        } catch (error) {
            this.logger.error('Failed to reconcile scheduled account sanctions', error);
        }
    }
}
