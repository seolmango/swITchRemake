import {
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { and, eq, gt, isNull, lte, ne, or } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';

type SanctionType = typeof schema.sanctionTypeEnum.enumValues[number];
type AccountStatus = typeof schema.accountStatusEnum.enumValues[number];
type RequestMeta = Record<string, unknown>;

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
    requestMeta?: RequestMeta;
}

@Injectable()
export class SanctionService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SanctionService.name);
    private reconciliationTimer?: NodeJS.Timeout;

    constructor(
        @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    ) {}

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

            await tx.insert(schema.adminAuditLog).values({
                actor: input.actor,
                action: 'SANCTION_CREATED',
                targetType: 'sanction',
                targetId: sanction.id,
                reason: input.reason,
                requestMeta: input.requestMeta ?? {},
            });

            return sanction;
        };

        return tx ? run(tx) : this.db.transaction(run);
    }

    async revoke(
        sanctionId: string,
        actor: string,
        reason: string,
        requestMeta: RequestMeta = {},
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
                requestMeta,
            });
        });
    }

    async deleteAccount(
        userId: number,
        actor: string,
        reason: string,
        requestMeta: RequestMeta = {},
    ): Promise<void> {
        await this.db.transaction(async (tx) => {
            const [user] = await tx.select({ status: schema.users.accountStatus })
                .from(schema.users)
                .where(eq(schema.users.id, userId))
                .for('update');
            if (!user) {
                throw new NotFoundException('User not found');
            }

            const now = new Date();
            await tx.update(schema.users).set({
                accountStatus: 'DELETED',
                updatedAt: now,
            }).where(eq(schema.users.id, userId));
            await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
            await tx.insert(schema.adminAuditLog).values({
                actor,
                action: 'ACCOUNT_DELETED',
                targetType: 'user',
                targetId: String(userId),
                reason,
                requestMeta,
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
                        requestMeta: { source },
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
                requestMeta: { source },
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
            for (const userId of userIds) {
                await this.reconcileUserStatus(userId, 'scheduler');
            }
        } catch (error) {
            this.logger.error('Failed to reconcile scheduled account sanctions', error);
        }
    }
}
