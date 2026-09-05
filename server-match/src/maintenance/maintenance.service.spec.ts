import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminController } from '../admin/admin.controller';
import { AuthController } from '../auth/auth.controller';
import * as schema from '../database/schema';
import { RoomsController } from '../rooms/rooms.controller';
import { UpdateMaintenanceDto } from './dto/update-maintenance.dto';
import { BLOCK_DURING_MAINTENANCE } from './maintenance.decorator';
import { MaintenanceService } from './maintenance.service';

class FakeRedis {
    readonly values = new Map<string, string>();
    readonly events: string[] = [];

    async get(key: string): Promise<string | null> {
        return this.values.get(key) ?? null;
    }

    async set(key: string, value: string): Promise<void> {
        this.events.push('redis-set');
        this.values.set(key, value);
    }
}

function harness() {
    const redis = new FakeRedis();
    const audits: Record<string, unknown>[] = [];
    const db = {
        insert: (table: unknown) => {
            assert.equal(table, schema.adminAuditLog);
            return {
                values: async (value: Record<string, unknown>) => {
                    redis.events.push('audit');
                    audits.push(value);
                },
            };
        },
    };
    return { redis, audits, service: new MaintenanceService(db as never, redis as never) };
}

test('점검 상태는 Redis에 남고 성공한 변경보다 감사 로그가 먼저 기록된다', async () => {
    const { redis, audits, service } = harness();
    assert.deepEqual(await service.getPublicState(), { status: 'ready' });

    const state = await service.update(7, {
        status: 'maintenance',
        returnsAt: '2099-01-02T03:04:05+09:00',
        notice: { ko: '점검 중입니다', en: 'Maintenance in progress' },
        reason: '정기 배포',
    });

    assert.deepEqual(state, {
        status: 'maintenance',
        returnsAt: '2099-01-01T18:04:05.000Z',
        notice: { ko: '점검 중입니다', en: 'Maintenance in progress' },
    });
    assert.deepEqual(redis.events, ['audit', 'redis-set']);
    assert.equal(audits[0]?.actor, 'admin:7');
    assert.equal(audits[0]?.action, 'service-state.update');
    assert.equal(audits[0]?.reason, '정기 배포');
    assert.deepEqual(await service.getPublicState(), state);

    await assert.rejects(service.assertAcceptingNewEntries(), (error: unknown) => {
        assert.ok(error instanceof HttpException);
        assert.equal(error.getStatus(), 423);
        assert.deepEqual(error.getResponse(), {
            code: 'MAINTENANCE',
            status: 'maintenance',
            returnsAt: '2099-01-01T18:04:05.000Z',
            notice: { ko: '점검 중입니다', en: 'Maintenance in progress' },
        });
        return true;
    });
});

test('ready 공지는 서버가 id를 만들며 ready 재설정으로 지울 수 있다', async () => {
    const { service } = harness();
    const announced = await service.update(3, {
        status: 'ready',
        announcement: { ko: '새 시즌', en: 'New season' },
        reason: '시즌 공지 게시',
    });
    assert.equal(announced.status, 'ready');
    assert.match(announced.status === 'ready' ? announced.announcement?.id ?? '' : '', /^[0-9a-f-]{36}$/i);
    assert.deepEqual(announced.status === 'ready' ? announced.announcement?.message : undefined, {
        ko: '새 시즌',
        en: 'New season',
    });

    assert.deepEqual(await service.update(3, {
        status: 'ready',
        reason: '시즌 공지 종료',
    }), { status: 'ready' });
});

test('공지와 점검 문구는 ko/en 중 한쪽만 오면 DTO에서 거절된다', async () => {
    const badNotice = plainToInstance(UpdateMaintenanceDto, {
        status: 'maintenance',
        returnsAt: '2099-01-01T00:00:00.000Z',
        notice: { ko: '점검 중' },
        reason: '점검',
    });
    const badAnnouncement = plainToInstance(UpdateMaintenanceDto, {
        status: 'ready',
        announcement: { en: 'News' },
        reason: '공지',
    });
    assert.ok((await validate(badNotice)).length > 0);
    assert.ok((await validate(badAnnouncement)).length > 0);
});

test('새 로그인과 새 방 진입만 점검 차단 대상으로 표시한다', () => {
    const reflector = new Reflector();
    for (const handler of [
        AuthController.prototype.login,
        AuthController.prototype.completeMfaLogin,
        AuthController.prototype.resendMfaLoginEmail,
        AuthController.prototype.guest,
        RoomsController.prototype.create,
        RoomsController.prototype.quickJoin,
        RoomsController.prototype.joinByCode,
        RoomsController.prototype.join,
    ]) {
        assert.equal(reflector.get(BLOCK_DURING_MAINTENANCE, handler), true);
    }
    for (const handler of [
        AuthController.prototype.refresh,
        AuthController.prototype.refreshGuest,
        RoomsController.prototype.resume,
        RoomsController.prototype.list,
        AdminController.prototype.updateMaintenance,
    ]) {
        assert.equal(reflector.get(BLOCK_DURING_MAINTENANCE, handler), undefined);
    }
});
