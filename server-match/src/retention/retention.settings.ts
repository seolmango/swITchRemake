/**
 * 보관 기간. 신고 창과 정리 작업이 **같은 값**을 봐야 한다 — 두 군데 적으면 정책을 바꾸는
 * 순간 갈라지고, 그때 사라지는 것은 증거다.
 *
 * 리플레이는 사람별 기준이다. 파일 하나를 최대 8명이 나눠 갖기 때문에, 참가자 중 한 명이라도
 * 자기 최근 `replayPerUserMatches`경기 안에 들고 있고 그것이 `replayDays` 안이면 남긴다.
 */
export interface RetentionSettings {
    /** 경기 전적(경기·참가자 행)을 남기는 기간. */
    matchDays: number;
    /** 리플레이를 남기는 기간. */
    replayDays: number;
    /** 한 사람이 보관하는 최근 경기 수. */
    replayPerUserMatches: number;
    /** 정리 회차 사이의 간격(분). */
    intervalMinutes: number;
}

export const RETENTION_DEFAULTS: RetentionSettings = {
    matchDays: 30,
    replayDays: 7,
    replayPerUserMatches: 50,
    intervalMinutes: 10,
};

const positiveInteger = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`보관 설정은 양의 정수여야 한다: ${raw}`);
    }
    return value;
};

export function retentionSettings(env: NodeJS.ProcessEnv = process.env): RetentionSettings {
    return {
        matchDays: positiveInteger(env.MATCH_RETENTION_DAYS, RETENTION_DEFAULTS.matchDays),
        replayDays: positiveInteger(env.REPLAY_RETENTION_DAYS, RETENTION_DEFAULTS.replayDays),
        replayPerUserMatches: positiveInteger(
            env.REPLAY_RETENTION_MAX_MATCHES,
            RETENTION_DEFAULTS.replayPerUserMatches,
        ),
        intervalMinutes: positiveInteger(
            env.RETENTION_INTERVAL_MINUTES,
            RETENTION_DEFAULTS.intervalMinutes,
        ),
    };
}
