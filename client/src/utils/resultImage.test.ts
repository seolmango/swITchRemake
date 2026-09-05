import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MatchPlayerResult, MatchResultSnapshot } from '../api/matches.ts';
import { createResultImage, resultImageWinnerCardLayout } from './resultImage.ts';

interface DrawnText {
    text: string;
    x: number;
    y: number;
    font: string;
}

const nicknames = ['가', '나', '다', '라', '마', '바', '사', '아'].map((letter) => letter.repeat(12));
const players: MatchPlayerResult[] = nicknames.map((nickname, index) => ({
    playerId: String(index + 1),
    isGuest: false,
    slot: index + 1,
    nickname,
    tagCount: index,
    taggedCount: index,
    switchSuccess: index,
    switchTry: index + 1,
    survivedMs: 60_000,
    isSelf: index === 0,
}));

const result: MatchResultSnapshot = {
    matchId: '11111111-1111-4111-8111-111111111111',
    roomId: 'room-1',
    map: 'default',
    durationMs: 60_000,
    playedAt: '2026-09-05T00:00:00.000Z',
    winners: players.map((player) => player.playerId),
    players,
};

const labels = {
    title: '경기 결과',
    winner: '공동 승리자',
    noWinner: '승리자 없음',
    noWinnerDetail: '남은 플레이어가 없습니다.',
    victory: '승리',
    map: '맵',
    duration: '1:00',
    player: '플레이어',
    switchRate: '스위치',
    tags: '잡기',
    you: '나',
};

afterEach(() => vi.unstubAllGlobals());

describe('result image winner layout', () => {
    it('keeps eight compact winner cards inside the winner area', () => {
        const cards = Array.from({ length: 8 }, (_, index) => resultImageWinnerCardLayout(8, index));

        expect(cards.every((card) => card.compact)).toBe(true);
        expect(cards.every((card) => card.x >= 100 && card.x + card.width <= 980)).toBe(true);
        expect(cards.every((card) => card.y >= 215 && card.y + card.height <= 450)).toBe(true);
        expect(cards.every((card) => card.width - 64 - 12 >= 12 * 20)).toBe(true);
    });

    it('draws all eight 12-character Korean nicknames in the compact cards', async () => {
        const drawnText: DrawnText[] = [];
        const context = {
            font: '',
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 0,
            textAlign: 'left',
            textBaseline: 'middle',
            beginPath: vi.fn(),
            roundRect: vi.fn(),
            fill: vi.fn(),
            stroke: vi.fn(),
            arc: vi.fn(),
            fillRect: vi.fn(),
            fillText(text: string, x: number, y: number) {
                drawnText.push({ text, x, y, font: context.font });
            },
        };
        const canvas = {
            width: 0,
            height: 0,
            getContext: vi.fn(() => context),
            toBlob: (callback: BlobCallback) => callback(new Blob(['image'], { type: 'image/png' })),
        };
        vi.stubGlobal('document', {
            fonts: { ready: Promise.resolve() },
            createElement: vi.fn(() => canvas),
        });

        await expect(createResultImage(result, labels)).resolves.toBeInstanceOf(Blob);
        nicknames.forEach((nickname) => {
            expect(drawnText).toContainEqual(expect.objectContaining({
                text: nickname,
                y: expect.any(Number),
                font: expect.stringContaining('20px'),
            }));
        });
        expect(drawnText.filter((draw) => nicknames.includes(draw.text) && draw.y < 450)).toHaveLength(8);
    });
});
