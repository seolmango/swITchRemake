import type { LobbyPlayer, PlayerRole } from 'shared';

/** 서버가 허용한 경기 참가자와 탈락 관전자만 인게임 화면으로 보낸다. */
export const canEnterRunningGame = (role: PlayerRole | null): boolean => role === 'player' || role === 'spectator';

/** 로비 스냅샷이 오면 내 역할도 같은 권위 상태로 맞춘다. */
export const roleFromLobby = (
    currentRole: PlayerRole | null,
    selfId: number | null,
    players: readonly LobbyPlayer[],
): PlayerRole | null => players.find((player) => player.playerId === selfId)?.role ?? currentRole;
