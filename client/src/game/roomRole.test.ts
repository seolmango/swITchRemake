import { describe, expect, it } from 'vitest';
import type { LobbyPlayer } from 'shared';
import { canEnterRunningGame, roleFromLobby } from './roomRole.ts';

const player = (playerId: number, role: LobbyPlayer['role']): LobbyPlayer => ({
    playerId,
    slot: playerId,
    nickname: `player-${playerId}`,
    colorIndex: playerId,
    guest: false,
    role,
    skills: ['dash'],
    stats: null,
});

describe('경기 중 역할 화면', () => {
    it('경기 중 들어와 waiting을 받은 사람에게 인게임·관전 진입을 열지 않는다', () => {
        expect(canEnterRunningGame('waiting')).toBe(false);
        expect(canEnterRunningGame(null)).toBe(false);
    });

    it('참가자와 서버가 정한 탈락 관전자만 인게임 화면으로 들어간다', () => {
        expect(canEnterRunningGame('player')).toBe(true);
        expect(canEnterRunningGame('spectator')).toBe(true);
    });

    it('결과 뒤 로비 스냅샷의 일반 참가자 역할로 되돌린다', () => {
        expect(roleFromLobby('spectator', 2, [player(1, 'player'), player(2, 'player')])).toBe('player');
        expect(roleFromLobby('waiting', 2, [player(1, 'player'), player(2, 'player')])).toBe('player');
    });
});
