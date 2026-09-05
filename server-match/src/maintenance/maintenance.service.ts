import {
    BadRequestException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import { makeKeys } from 'shared';
import { auditContext } from '../admin/audit-log';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';
import { RedisService } from '../redis/redis.service';
import type { LocalizedMessageDto, UpdateMaintenanceDto } from './dto/update-maintenance.dto';

export interface LocalizedMessage {
    ko: string;
    en: string;
}

export type PublicServiceState =
    | {
        status: 'ready';
        announcement?: { id: string; message: LocalizedMessage };
    }
    | {
        status: 'maintenance';
        returnsAt: string;
        notice?: LocalizedMessage;
    };

type StoredServiceState = PublicServiceState & { version: 1 };

@Injectable()
export class MaintenanceService {
    private readonly stateKey = makeKeys(process.env.APP_ENV ?? 'dev').operation('service-state');

    constructor(
        @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
        private readonly redis: RedisService,
    ) {}

    /** 키가 없으면 기존 배포와 같은 ready/no-announcement 상태다. 값은 TTL 없이 재시작을 견딘다. */
    async getPublicState(): Promise<PublicServiceState> {
        const raw = await this.redis.get(this.stateKey);
        if (raw === null) return { status: 'ready' };
        try {
            return this.toPublicState(this.decode(raw));
        } catch {
            throw new ServiceUnavailableException({ code: 'SERVICE_STATE_UNAVAILABLE', retryable: true });
        }
    }

    /**
     * 감사 행을 먼저 쓴 뒤 Redis 공개 상태를 바꾼다.
     *
     * 따라서 성공한 변경에는 반드시 append-only 감사 행이 먼저 존재한다. Redis 쓰기가 실패하면
     * 요청은 실패하고, 감사 행은 실패한 운영 시도까지 보여 주는 기록으로 남는다.
     */
    async update(actorUserId: number, dto: UpdateMaintenanceDto): Promise<PublicServiceState> {
        const rawPrevious = await this.redis.get(this.stateKey);
        let previous: PublicServiceState | null = null;
        let previousStatus = rawPrevious === null ? 'ready' : 'invalid';
        if (rawPrevious !== null) {
            try {
                previous = this.toPublicState(this.decode(rawPrevious));
                previousStatus = previous.status;
            } catch {
                // 손상된 값을 운영 API로 복구할 수 있어야 한다. 감사 로그에는 invalid였음을 남긴다.
            }
        }

        const next = this.buildState(dto);
        await this.db.insert(schema.adminAuditLog).values({
            actor: `admin:${actorUserId}`,
            action: 'service-state.update',
            targetType: 'service',
            targetId: 'matching',
            reason: dto.reason,
            ...auditContext({
                previousStatus,
                nextStatus: next.status,
                previousAnnouncementId: previous?.status === 'ready' ? previous.announcement?.id ?? null : null,
                nextAnnouncementId: next.status === 'ready' ? next.announcement?.id ?? null : null,
                returnsAt: next.status === 'maintenance' ? next.returnsAt : null,
                hasNotice: next.status === 'maintenance' && next.notice !== undefined,
            }),
        });
        await this.redis.set(this.stateKey, JSON.stringify({ version: 1, ...next } satisfies StoredServiceState));
        return next;
    }

    /** 점검은 장애가 아니므로 차단 응답도 5xx 대신 명시적인 423 상태와 계약 본문을 쓴다. */
    async assertAcceptingNewEntries(): Promise<void> {
        const state = await this.getPublicState();
        if (state.status === 'ready') return;
        throw new HttpException({
            code: 'MAINTENANCE',
            status: 'maintenance',
            returnsAt: state.returnsAt,
            ...(state.notice ? { notice: state.notice } : {}),
        }, HttpStatus.LOCKED);
    }

    private buildState(dto: UpdateMaintenanceDto): PublicServiceState {
        if (dto.status === 'ready') {
            if (dto.returnsAt !== undefined || dto.notice !== undefined) {
                this.invalidCombination('ready 상태에는 returnsAt 또는 notice를 보낼 수 없습니다');
            }
            return {
                status: 'ready',
                ...(dto.announcement ? {
                    announcement: { id: randomUUID(), message: this.message(dto.announcement) },
                } : {}),
            };
        }

        if (dto.status !== 'maintenance' || typeof dto.returnsAt !== 'string' || dto.announcement !== undefined) {
            this.invalidCombination('maintenance 상태에는 returnsAt이 필요하고 announcement를 보낼 수 없습니다');
        }
        const timestamp = Date.parse(dto.returnsAt);
        if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
            this.invalidCombination('returnsAt은 현재보다 뒤인 ISO-8601 시각이어야 합니다');
        }
        return {
            status: 'maintenance',
            returnsAt: new Date(timestamp).toISOString(),
            ...(dto.notice ? { notice: this.message(dto.notice) } : {}),
        };
    }

    private message(value: LocalizedMessageDto): LocalizedMessage {
        const ko = typeof value?.ko === 'string' ? value.ko.trim() : '';
        const en = typeof value?.en === 'string' ? value.en.trim() : '';
        if (!ko || !en || ko.length > 2_000 || en.length > 2_000) {
            this.invalidCombination('공지 문구에는 2,000자 이하의 ko와 en이 모두 필요합니다');
        }
        return { ko, en };
    }

    private invalidCombination(message: string): never {
        throw new BadRequestException({ code: 'INVALID_SERVICE_STATE', message });
    }

    private decode(raw: string): StoredServiceState {
        const value: unknown = JSON.parse(raw);
        if (!isRecord(value) || value.version !== 1) throw new Error('Unsupported service state');
        if (value.status === 'ready') {
            if (value.announcement === undefined) return { version: 1, status: 'ready' };
            if (!isRecord(value.announcement) || typeof value.announcement.id !== 'string') {
                throw new Error('Invalid announcement');
            }
            return {
                version: 1,
                status: 'ready',
                announcement: {
                    id: value.announcement.id,
                    message: this.storedMessage(value.announcement.message),
                },
            };
        }
        if (value.status !== 'maintenance' || typeof value.returnsAt !== 'string') {
            throw new Error('Invalid maintenance state');
        }
        const returnsAt = new Date(value.returnsAt);
        if (!Number.isFinite(returnsAt.getTime())) throw new Error('Invalid returnsAt');
        return {
            version: 1,
            status: 'maintenance',
            returnsAt: returnsAt.toISOString(),
            ...(value.notice === undefined ? {} : { notice: this.storedMessage(value.notice) }),
        };
    }

    private storedMessage(value: unknown): LocalizedMessage {
        if (!isRecord(value) || typeof value.ko !== 'string' || !value.ko.trim()
            || typeof value.en !== 'string' || !value.en.trim()) {
            throw new Error('Invalid localized message');
        }
        return { ko: value.ko, en: value.en };
    }

    private toPublicState(value: StoredServiceState): PublicServiceState {
        if (value.status === 'ready') {
            return { status: 'ready', ...(value.announcement ? { announcement: value.announcement } : {}) };
        }
        return {
            status: 'maintenance',
            returnsAt: value.returnsAt,
            ...(value.notice ? { notice: value.notice } : {}),
        };
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
