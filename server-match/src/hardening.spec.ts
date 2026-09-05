import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FASTIFY_RESOURCE_LIMITS } from './http-limits';
import { GLOBAL_VALIDATION_OPTIONS } from './validation-options';
import { LoginDto } from './auth/dto/login.dto';
import { GuestRefreshDto } from './auth/dto/guest-refresh.dto';
import { UpdateReportStatusDto } from './reports/dto/update-report-status.dto';
import { AdminController } from './admin/admin.controller';
import { BadRequestException } from '@nestjs/common';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from './database/schema';

test('이메일 DTO는 저장소와 Redis 키에 닿기 전에 trim/lowercase한다', async () => {
    const dto = plainToInstance(LoginDto, { email: ' User@Example.COM ', password: 'Password1!' });
    assert.equal((await validate(dto)).length, 0);
    assert.equal(dto.email, 'user@example.com');
});

test('DB 스키마도 lower(email) 유일 인덱스를 선언한다', () => {
    assert.ok(getTableConfig(schema.users).indexes.some((index) => index.config.name === 'users_email_lower_unique'));
});

test('게스트 refresh 토큰과 운영자 note에 길이 상한이 있다', async () => {
    const guest = plainToInstance(GuestRefreshDto, { refreshToken: 'x'.repeat(4097) });
    const report = plainToInstance(UpdateReportStatusDto, { status: 'OPEN', note: 'x'.repeat(2001) });
    assert.ok((await validate(guest)).some((error) => error.property === 'refreshToken'));
    assert.ok((await validate(report)).some((error) => error.property === 'note'));
});

test('HTTP 본문과 연결 시간, 전역 DTO의 미등록 필드에 상한을 둔다', () => {
    assert.deepEqual(FASTIFY_RESOURCE_LIMITS, {
        bodyLimit: 65_536,
        requestTimeout: 25_000,
        connectionTimeout: 25_000,
    });
    assert.equal(GLOBAL_VALIDATION_OPTIONS.whitelist, true);
    assert.equal(GLOBAL_VALIDATION_OPTIONS.forbidNonWhitelisted, true);
});

test('운영자 q가 배열이면 서비스에 넘기지 않고 400으로 거절한다', async () => {
    let called = false;
    const controller = new AdminController(
        {} as never,
        { lookup: async () => { called = true; } } as never,
        {} as never,
        {} as never,
    );
    await assert.rejects(controller.lookupPlayer({ user: { id: 1 } } as never, ['a', 'b']), BadRequestException);
    assert.equal(called, false);
});
