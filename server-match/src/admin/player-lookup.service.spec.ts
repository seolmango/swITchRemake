import assert from 'node:assert/strict';
import test from 'node:test';
import { PlayerLookupService } from './player-lookup.service';

const timestamp = '2026-10-04 08:01:00+00';
const iso = '2026-10-04T08:01:00.000Z';

test('audit log serializes raw PostgreSQL timestamp strings and keeps pagination', async () => {
    const row = { id: 2, actor: 'admin:1', action: 'player.lookup', targetType: 'user', targetId: '7', reason: 'lookup', createdAt: timestamp };
    const db = { execute: async () => [row, { ...row, id: 1 }] };
    const service = new PlayerLookupService(db as never);
    const page = await service.auditLog(1);
    assert.deepEqual(page.items[0], { id: 2, actor: 'admin:1', action: 'player.lookup', target: 'user:7', reason: 'lookup', createdAt: iso });
    assert.equal(page.nextBefore, 2);
});

test('player lookup serializes raw account and sanction timestamps, including nullable dates', async () => {
    let reads = 0;
    let audits = 0;
    const player = { userId: 7, nickname: 'Player', accountStatus: 'ACTIVE', role: 'USER', createdAt: timestamp, activeSessions: 1, reportsAgainst: 0, reportsFiled: 0, recentMatches: 2 };
    const sanction = { id: 'sanction', type: 'WARN', scope: 'account', startsAt: timestamp, expiresAt: null, reason: 'test', createdBy: 'admin:1', revokedAt: null };
    const db = { execute: async () => ++reads === 1 ? [player] : [sanction, { ...sanction, expiresAt: new Date(iso), revokedAt: timestamp }], insert: () => ({ values: async () => { audits++; } }) };
    const response = await new PlayerLookupService(db as never).lookup(1, 'Player');
    assert.equal(response.player.createdAt, iso);
    assert.equal(response.sanctions[0].startsAt, iso);
    assert.equal(response.sanctions[0].expiresAt, null);
    assert.equal(response.sanctions[0].revokedAt, null);
    assert.equal(response.sanctions[1].expiresAt, iso);
    assert.equal(response.sanctions[1].revokedAt, iso);
    assert.equal(audits, 1);
});
