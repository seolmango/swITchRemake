import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import test from 'node:test';
import { MatchesController } from './matches.controller';
import { MatchesService } from './matches.service';

const MATCH_ID = '11111111-1111-4111-8111-111111111111';
const startedAt = new Date('2026-01-01T00:00:00.000Z');
const endedAt = new Date('2026-01-01T00:01:00.000Z');

type MatchRow = {
    matchId: string;
    roomId: string | null;
    mapId: string;
    startedAt: Date | null;
    endedAt: Date | null;
    resultRecordedAt: Date | null;
    playerId: number | null;
    userId: number | null;
    nickname: string | null;
    isGuest: boolean | null;
    isWinner: boolean | null;
    tagCount: number | null;
    taggedCount: number | null;
    switchSuccess: number | null;
    switchTry: number | null;
    survivedMs: number | null;
};

function database(rows: MatchRow[], assignment: { nickname: string; isGuest: boolean } | null) {
    let selectCount = 0;
    return {
        select: () => {
            if (selectCount++ === 0) {
                return { from: () => ({ leftJoin: () => ({ where: () => ({ orderBy: async () => rows }) }) }) };
            }
            return { from: () => ({ where: () => ({ limit: async () => assignment ? [assignment] : [] }) }) };
        },
    };
}

function completedRows(): MatchRow[] {
    return [
        {
            matchId: MATCH_ID, roomId: 'room-1', mapId: 'BattleField', startedAt, endedAt, resultRecordedAt: endedAt,
            playerId: 1, userId: 7, nickname: 'Account', isGuest: false, isWinner: true,
            tagCount: 4, taggedCount: 1, switchSuccess: 2, switchTry: 3, survivedMs: 60_000,
        },
        {
            matchId: MATCH_ID, roomId: 'room-1', mapId: 'BattleField', startedAt, endedAt, resultRecordedAt: endedAt,
            playerId: 2, userId: null, nickname: 'Guest_7KPW2M', isGuest: true, isWinner: true,
            tagCount: 1, taggedCount: 0, switchSuccess: 1, switchTry: 2, survivedMs: 60_000,
        },
    ];
}

test('returns the client MatchResultSnapshot and includes a guest participant without personal data', async () => {
    const service = new MatchesService(database(completedRows(), { nickname: 'Guest_7KPW2M', isGuest: true }) as never);
    const result = await service.getResult(MATCH_ID, 'g:22222222-2222-4222-8222-222222222222');

    assert.deepEqual(result, {
        matchId: MATCH_ID,
        roomId: 'room-1',
        map: 'BattleField',
        durationMs: 60_000,
        playedAt: '2026-01-01T00:01:00.000Z',
        winners: ['1', '2'],
        players: [
            { playerId: '1', slot: 1, nickname: 'Account', tagCount: 4, taggedCount: 1, switchSuccess: 2, switchTry: 3, survivedMs: 60_000, isSelf: false },
            { playerId: '2', slot: 2, nickname: 'Guest_7KPW2M', tagCount: 1, taggedCount: 0, switchSuccess: 1, switchTry: 2, survivedMs: 60_000, isSelf: true },
        ],
    });
});

test('returns 404 for an unknown match', async () => {
    const service = new MatchesService(database([], null) as never);
    await assert.rejects(
        () => service.getResult(MATCH_ID, 7),
        (error: unknown) => error instanceof NotFoundException && error.getStatus() === 404,
    );
});

test('returns a retryable pending response before the result worker commits', async () => {
    const pending = completedRows()[0]!;
    pending.resultRecordedAt = null;
    pending.playerId = null;
    pending.userId = null;
    pending.nickname = null;
    pending.isGuest = null;
    pending.isWinner = null;
    pending.tagCount = null;
    pending.taggedCount = null;
    pending.switchSuccess = null;
    pending.switchTry = null;
    pending.survivedMs = null;
    const service = new MatchesService(database([pending], { nickname: 'Account', isGuest: false }) as never);
    assert.deepEqual(await service.getResult(MATCH_ID, 7), { status: 'pending', retryAfterMs: 500 });
});

test('controller maps a pending result to HTTP 202', async () => {
    const controller = new MatchesController({ getResult: async () => ({ status: 'pending' as const, retryAfterMs: 500 }) } as never);
    const statuses: number[] = [];
    const result = await controller.getResult(
        { user: { id: 7 } },
        MATCH_ID,
        { status: (code: number) => { statuses.push(code); } },
    );
    assert.deepEqual(result, { status: 'pending', retryAfterMs: 500 });
    assert.deepEqual(statuses, [202]);
});
