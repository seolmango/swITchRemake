/**
 * drizzle은 postgres 오류를 `DrizzleQueryError`로 **감싸서** 던진다. 그래서 `error.code`를
 * 그대로 보면 항상 undefined이고, 유일성 위반 같은 것을 잡으려던 분기가 조용히 500으로
 * 떨어진다. 실제로 그렇게 새어 나간 적이 있다 — 중복 이메일 가입이 409 대신 500을 냈고,
 * 그 경로를 밟는 점검이 없어서 아무도 몰랐다.
 *
 * 원본은 `cause`에 들어 있고, 감싸는 층이 하나라는 보장이 없어 몇 단계 따라간다.
 */
export interface PostgresError {
    code?: string;
    detail?: string;
    constraint?: string;
    constraint_name?: string;
}

const MAX_DEPTH = 4;

/** `cause` 체인을 따라가며 지정한 SQLSTATE를 가진 원본 오류를 찾는다. 없으면 null. */
export function findPostgresError(error: unknown, code: string): PostgresError | null {
    let current: unknown = error;
    for (let depth = 0; depth < MAX_DEPTH && current && typeof current === 'object'; depth += 1) {
        const candidate = current as PostgresError & { cause?: unknown };
        if (candidate.code === code) return candidate;
        current = candidate.cause;
    }
    return null;
}

/** 유일성 위반이 어느 제약에서 났는지 사람이 읽을 수 있는 한 덩어리로 돌려준다. */
export function uniqueViolationTarget(error: unknown): string | null {
    const pg = findPostgresError(error, '23505');
    if (!pg) return null;
    return `${pg.detail ?? ''} ${pg.constraint ?? ''} ${pg.constraint_name ?? ''}`;
}
