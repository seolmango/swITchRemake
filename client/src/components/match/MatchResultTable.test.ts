import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MatchPlayerResult } from '../../api/matches.ts';
import { MatchResultTable } from './MatchResultTable.tsx';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

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
    isSelf: false,
}));

describe('MatchResultTable winner presentation', () => {
    it('renders all eight co-winners and their 12-character Korean nicknames', () => {
        const html = renderToStaticMarkup(React.createElement(MatchResultTable, {
            players,
            winnerIds: players.map((player) => player.playerId),
        }));

        expect((html.match(/class="is-winner"/gu) ?? [])).toHaveLength(8);
        expect((html.match(/<em>result\.victory<\/em>/gu) ?? [])).toHaveLength(8);
        nicknames.forEach((nickname) => expect(html).toContain(nickname));
    });

    it('uses the single-winner label for a one-person winner list', () => {
        const html = renderToStaticMarkup(React.createElement(MatchResultTable, {
            players,
            winnerIds: [players[0]!.playerId],
        }));

        expect(html).toContain('<em>result.victorySingle</em>');
        expect((html.match(/class="is-winner"/gu) ?? [])).toHaveLength(1);
    });
});
