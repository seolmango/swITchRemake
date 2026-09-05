import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

test('liveness는 의존성 없이 살고 readiness는 DB와 Redis를 모두 확인한다', async () => {
    let dbChecks = 0;
    let redisChecks = 0;
    const db = { execute: async () => { dbChecks++; } };
    const redis = { ping: async () => { redisChecks++; return true; } };
    const email = { getHealthStatus: () => ({ status: 'ok' }) };
    const maintenance = { getPublicState: async () => ({
        status: 'ready',
        announcement: { id: 'notice-1', message: { ko: '공지', en: 'Notice' } },
    }) };
    const controller = new HealthController(email as never, db as never, redis as never, maintenance as never);
    assert.equal(controller.liveness().status, 'alive');
    const response = await controller.readiness();
    assert.deepEqual(response, {
        status: 'ready',
        timestamp: response.timestamp,
        email: { status: 'ok' },
        announcement: { id: 'notice-1', message: { ko: '공지', en: 'Notice' } },
    });
    assert.equal(dbChecks, 1);
    assert.equal(redisChecks, 1);
});

test('점검 중 readiness는 DB가 내려가 있어도 계약 본문을 HTTP 200 응답으로 돌려줄 수 있다', async () => {
    let dbChecks = 0;
    let redisPings = 0;
    const controller = new HealthController(
        { getHealthStatus: () => ({}) } as never,
        { execute: async () => { dbChecks++; throw new Error('db down'); } } as never,
        { ping: async () => { redisPings++; return true; } } as never,
        { getPublicState: async () => ({
            status: 'maintenance',
            returnsAt: '2099-01-01T00:00:00.000Z',
            notice: { ko: '점검 중', en: 'Maintenance' },
        }) } as never,
    );

    const response = await controller.readiness();
    assert.equal(response.status, 'maintenance');
    if (response.status !== 'maintenance') throw new Error('expected maintenance');
    assert.equal(response.returnsAt, '2099-01-01T00:00:00.000Z');
    assert.deepEqual(response.notice, { ko: '점검 중', en: 'Maintenance' });
    assert.equal(typeof response.timestamp, 'number');
    assert.equal(dbChecks, 0);
    assert.equal(redisPings, 0);
});

test('readiness는 저장소가 죽으면 503을 낸다', async () => {
    const controller = new HealthController(
        { getHealthStatus: () => ({}) } as never,
        { execute: async () => { throw new Error('db down'); } } as never,
        { ping: async () => true } as never,
        { getPublicState: async () => ({ status: 'ready' }) } as never,
    );
    await assert.rejects(controller.readiness(), ServiceUnavailableException);
});
