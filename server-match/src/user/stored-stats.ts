/**
 * `users.stats` JSONB를 읽는 곳. 저장 형태(짧은 키)와 바깥에 보이는 형태를 잇는 유일한 자리다.
 *
 * 비율 계산이 여기 있는 이유: 같은 사람의 승률이 프로필 화면과 로비 카드에서 다르게 반올림되면
 * 사용자는 둘 중 하나를 버그로 읽는다. 계산이 한 벌이면 그런 일이 없다.
 */

import type { LobbyStats } from 'shared';

export interface StoredStats {
    xp: number;
    games: number;
    wins: number;
    sw_try: number;
    sw_su: number;
    kill: number;
    death_order: number;
    survived_ms: number;
    survived_games: number;
}

export const DEFAULT_STATS: StoredStats = {
    xp: 0,
    games: 0,
    wins: 0,
    sw_try: 0,
    sw_su: 0,
    kill: 0,
    death_order: 0,
    survived_ms: 0,
    survived_games: 0,
};

export const nonNegativeInteger = (value: unknown): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** 백분율, 소수 한 자리. 분모가 0이면 0이다 — NaN이 화면까지 나가면 안 된다. */
export const percentage = (numerator: number, denominator: number): number =>
    denominator === 0 ? 0 : Math.round(numerator / denominator * 1_000) / 10;

/** JSONB 컬럼은 무엇이든 들어올 수 있다. 모양이 아니면 기본값으로 떨어뜨린다. */
export const readStoredStats = (value: unknown): Partial<StoredStats> =>
    typeof value === 'object' && value !== null ? value as Partial<StoredStats> : DEFAULT_STATS;

/** 로비 카드용 요약. 게스트에게는 애초에 부르지 않는다. */
export function lobbyStatsFrom(value: unknown): LobbyStats {
    const stored = readStoredStats(value);
    const games = nonNegativeInteger(stored.games);
    const wins = nonNegativeInteger(stored.wins);
    const switchTry = nonNegativeInteger(stored.sw_try);
    const switchSuccess = nonNegativeInteger(stored.sw_su);
    return {
        games,
        wins,
        winRate: percentage(wins, games),
        switchSuccessRate: percentage(switchSuccess, switchTry),
    };
}
