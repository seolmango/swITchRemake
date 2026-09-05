/**
 * 보관 기간. 신고 창과 정리 작업이 **같은 값**을 봐야 한다 — 두 군데 적으면 정책을 바꾸는
 * 순간 갈라지고, 그때 사라지는 것은 증거다.
 *
 * 리플레이는 경기 종료 뒤의 시간만 본다. 사람별 최근 경기 수를 섞으면 활동량에 따라 실제
 * 보관 기간이 달라져 "2시간"이라는 약속을 지킬 수 없다.
 */
export interface RetentionSettings {
    /** 경기 전적(경기·참가자 행)을 남기는 기간. */
    matchDays: number;
    /** 리플레이를 남기는 시간. */
    replayHours: number;
    /** 정리 회차 사이의 간격(분). */
    intervalMinutes: number;
    /**
     * 끝난 세션 행을 남기는 기간.
     *
     * refresh는 회전할 때마다 새 행을 만든다 - 활성 사용자 한 명이 하루 100행쯤 쌓는다.
     * 만료·폐기된 행은 인증에 쓰이지 않지만 지우는 사람이 없으면 테이블과 인덱스만 부푼다.
     * 바로 지우지 않는 이유는 "어느 기기에서 언제 로그인했나"를 사용자가 잠시 되짚을 수 있어야
     * 하기 때문이다.
     */
    sessionDays: number;
    /** 조사와 운영 변경 추적에 필요한 감사 로그 보관 기간. */
    auditLogDays: number;
    /** 감사 로그의 암호화 IP 원본을 남기는 짧은 기간. */
    auditIpDays: number;
}

export const RETENTION_DEFAULTS: RetentionSettings = {
    matchDays: 30,
    replayHours: 2,
    intervalMinutes: 10,
    sessionDays: 30,
    // 분쟁·제재 조사는 전적 30일을 지나 이어질 수 있어 1년을 남기되 무기한 보관하지 않는다.
    auditLogDays: 365,
    // 세션 IP 원본과 같은 7일이면 단기 장애·공격 조사는 가능하고 장기 원본 축적은 피한다.
    auditIpDays: 7,
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
        replayHours: positiveInteger(env.REPLAY_RETENTION_HOURS, RETENTION_DEFAULTS.replayHours),
        intervalMinutes: positiveInteger(
            env.RETENTION_INTERVAL_MINUTES,
            RETENTION_DEFAULTS.intervalMinutes,
        ),
        sessionDays: positiveInteger(env.SESSION_RETENTION_DAYS, RETENTION_DEFAULTS.sessionDays),
        auditLogDays: positiveInteger(env.AUDIT_LOG_RETENTION_DAYS, RETENTION_DEFAULTS.auditLogDays),
        auditIpDays: positiveInteger(env.AUDIT_IP_RETENTION_DAYS, RETENTION_DEFAULTS.auditIpDays),
    };
}
