import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { UserService } from './user.service';

const endedAt = new Date('2026-08-25T03:00:00.000Z');

type HistoryRow = {
    matchId: string;
    endedAt: Date | null;
    map: string;
    won: boolean;
    tagCount: number;
    taggedCount: number;
    switchTry: number;
    switchSuccess: number;
    survivedMs: number;
};

const row = (matchId: string, offsetMinutes: number): HistoryRow => ({
    matchId,
    endedAt: new Date(endedAt.getTime() - offsetMinutes * 60_000),
    map: 'BattleField',
    won: offsetMinutes === 0,
    tagCount: 3,
    taggedCount: 1,
    switchTry: 4,
    switchSuccess: 2,
    survivedMs: 60_000,
});

function historyService(pages: HistoryRow[][]) {
    let selectCount = 0;
    const limits: number[] = [];
    const db = {
        select: () => {
            const page = pages[selectCount++] ?? [];
            return {
                from: () => ({
                    innerJoin: () => ({
                        where: () => ({
                            orderBy: () => ({
                                limit: async (limit: number) => {
                                    limits.push(limit);
                                    return page;
                                },
                            }),
                        }),
                    }),
                }),
            };
        },
    };
    return {
        service: new UserService(db as never, {} as never, {} as never, {} as never),
        limits,
        selected: () => selectCount,
    };
}

test('match history returns an empty keyset page', async () => {
    const { service, limits } = historyService([[]]);
    assert.deepEqual(await service.getMatches(7, 20), { matches: [], nextCursor: null });
    assert.deepEqual(limits, [21]);
});

test('match history cursor reaches the last page without duplicates', async () => {
    const firstId = '33333333-3333-4333-8333-333333333333';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const lastId = '11111111-1111-4111-8111-111111111111';
    const { service, limits } = historyService([
        [row(firstId, 0), row(secondId, 1), row(lastId, 2)],
        [row(lastId, 2)],
    ]);

    const firstPage = await service.getMatches(7, 2);
    assert.deepEqual(firstPage.matches.map((match) => match.matchId), [firstId, secondId]);
    assert.equal(typeof firstPage.nextCursor, 'string');

    const lastPage = await service.getMatches(7, 2, firstPage.nextCursor!);
    assert.deepEqual(lastPage.matches.map((match) => match.matchId), [lastId]);
    assert.equal(lastPage.nextCursor, null);
    assert.deepEqual(limits, [3, 3]);
});

test('match history rejects a malformed cursor before querying the database', async () => {
    const { service, selected } = historyService([]);
    await assert.rejects(
        () => service.getMatches(7, 20, 'not-a-valid-cursor'),
        (error: unknown) => error instanceof BadRequestException
            && error.getStatus() === 400
            && (error.getResponse() as { code?: string }).code === 'INVALID_MATCH_CURSOR',
    );
    assert.equal(selected(), 0);
});

test('stats response includes server-derived rates with one decimal precision', async () => {
    const db = {
        select: () => ({
            from: () => ({
                where: async () => [{ stats: {
                    level: 2, xp: 75, games: 3, wins: 2, sw_try: 6, sw_su: 4, kill: 9, death_order: 5,
                } }],
            }),
        }),
    };
    const service = new UserService(db as never, {} as never, {} as never, {} as never);
    assert.deepEqual(await service.getStats(7), {
        level: 2,
        xp: 75,
        games: 3,
        wins: 2,
        switchTry: 6,
        switchSuccess: 4,
        tagCount: 9,
        deathOrder: 5,
        winRate: 66.7,
        switchSuccessRate: 66.7,
    });
});
