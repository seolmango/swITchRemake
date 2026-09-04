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
    const controller = new HealthController(email as never, db as never, redis as never);
    assert.equal(controller.liveness().status, 'alive');
    assert.equal((await controller.readiness()).status, 'ready');
    assert.equal(dbChecks, 1);
    assert.equal(redisChecks, 1);
});

test('readiness는 저장소가 죽으면 503을 낸다', async () => {
    const controller = new HealthController(
        { getHealthStatus: () => ({}) } as never,
        { execute: async () => { throw new Error('db down'); } } as never,
        { ping: async () => true } as never,
    );
    await assert.rejects(controller.readiness(), ServiceUnavailableException);
});
