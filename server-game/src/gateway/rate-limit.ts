export type RateSubject = {
    connectionId: number;
    ip: string;
    userId?: number | string;
};

export interface RateDecision {
    allowed: boolean;
    /** Three consecutive windows exceeded the rule. */
    persistent: boolean;
    /** Traffic exceeded the malicious threshold for five consecutive windows. */
    abusive: boolean;
}

export type RateScope = 'connection' | 'ip' | 'user';

export interface RateCheckPolicy {
    scopes?: readonly RateScope[];
    abusiveMultiplier?: number;
    abusiveWindows?: number;
}

interface Bucket {
    window: number;
    /**
     * 이 시각이 지나면 streak 판정에도 쓸 수 없다. 회수 기준이다.
     *
     * 창 번호만으로는 지웠는지 알 수 없다 - 규칙마다 창 크기가 달라서 번호를 섞어 비교할 수
     * 없기 때문이다. 그래서 절대 시각을 들고 다닌다.
     */
    expiresAt: number;
    count: number;
    violated: boolean;
    violationStreak: number;
    abusive: boolean;
    abusiveStreak: number;
}

/** 죽은 버킷을 걷어내는 주기. 창 하나가 보통 1초라 이 정도면 몇 창 뒤에는 반드시 사라진다. */
const SWEEP_INTERVAL_MS = 5_000;

/** Fixed windows are deliberate: cheap bounded work on the single-threaded hot path. */
export class AbuseRateLimiter {
    readonly #buckets = new Map<string, Bucket>();
    readonly #cooldowns = new Map<string, number>();
    readonly #now: () => number;
    #nextSweepAt = 0;

    public constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    /**
     * 지난 창의 흔적을 걷어낸다.
     *
     * 예전에는 연결이 끊길 때 그 연결의 키만 지웠고, 그것도 **전체 키를 훑어서** 지웠다.
     * 사용자 단위 키는 지우는 사람이 아예 없었는데 게스트는 접속마다 새 신원이라 그 지도가
     * 끝없이 자랐고, 그렇게 자란 지도 때문에 연결 하나 끊는 비용도 같이 자랐다.
     *
     * 시간이 지나면 버킷은 어차피 판정에 쓰이지 않는다. 그러면 끊는 순간에 맞춰 지울 이유도
     * 없다 - 주기적으로 죽은 것만 버리면 두 문제가 같이 사라진다.
     */
    #sweep(now: number): void {
        if (now < this.#nextSweepAt) return;
        this.#nextSweepAt = now + SWEEP_INTERVAL_MS;
        for (const [key, bucket] of this.#buckets) if (bucket.expiresAt <= now) this.#buckets.delete(key);
        for (const [key, permittedAt] of this.#cooldowns) if (permittedAt <= now) this.#cooldowns.delete(key);
    }

    public check(rule: string, subject: RateSubject, limit: number, windowMs: number, policy: RateCheckPolicy = {}): RateDecision {
        const now = this.#now();
        this.#sweep(now);
        const window = Math.floor(now / windowMs);
        const abusiveMultiplier = policy.abusiveMultiplier ?? 5;
        const abusiveWindows = policy.abusiveWindows ?? 5;
        let allowed = true;
        let persistent = false;
        let abusive = false;
        for (const key of this.#subjectKeys(rule, subject, policy.scopes)) {
            let bucket = this.#buckets.get(key);
            if (bucket === undefined || bucket.window !== window) {
                const previous = bucket;
                const consecutive = previous !== undefined && previous.violated && previous.window === window - 1;
                const abusiveConsecutive = previous !== undefined && previous.abusive && previous.window === window - 1;
                bucket = {
                    window,
                    // 다음 창까지는 연속 위반 판정에 쓰인다. 그 뒤로는 아무도 보지 않는다.
                    expiresAt: (window + 2) * windowMs,
                    count: 0,
                    violated: false,
                    violationStreak: consecutive ? previous.violationStreak : 0,
                    abusive: false,
                    abusiveStreak: abusiveConsecutive ? previous.abusiveStreak : 0,
                };
                this.#buckets.set(key, bucket);
            }
            bucket.count += 1;
            if (bucket.count > limit) {
                allowed = false;
                if (!bucket.violated) {
                    bucket.violated = true;
                    bucket.violationStreak += 1;
                }
                persistent ||= bucket.violationStreak >= 3;
            }
            if (bucket.count > limit * abusiveMultiplier) {
                if (!bucket.abusive) {
                    bucket.abusive = true;
                    bucket.abusiveStreak += 1;
                }
                abusive ||= bucket.abusiveStreak >= abusiveWindows;
            }
        }
        return { allowed, persistent, abusive };
    }

    public cooldown(rule: string, subject: RateSubject, cooldownMs: number, scopes: readonly RateScope[] = ['ip', 'user']): RateDecision {
        const now = this.#now();
        this.#sweep(now);
        let allowed = true;
        for (const key of this.#subjectKeys(rule, subject, scopes)) {
            const permittedAt = this.#cooldowns.get(key) ?? 0;
            if (permittedAt > now) allowed = false;
        }
        if (allowed) {
            for (const key of this.#subjectKeys(rule, subject, scopes)) {
                this.#cooldowns.set(key, now + cooldownMs);
            }
        }
        return { allowed, persistent: false, abusive: false };
    }

    /** 검사용. 회수가 실제로 일어나는지 밖에서 볼 수 있어야 한다. */
    public size(): number {
        return this.#buckets.size + this.#cooldowns.size;
    }

    #subjectKeys(rule: string, subject: RateSubject, scopes: readonly RateScope[] = ['connection', 'ip', 'user']): string[] {
        const keys: string[] = [];
        if (scopes.includes('connection')) keys.push(`${rule}:connection:${subject.connectionId}`);
        if (scopes.includes('ip')) keys.push(`${rule}:ip:${subject.ip}`);
        if (scopes.includes('user') && subject.userId !== undefined) keys.push(`${rule}:user:${subject.userId}`);
        return keys;
    }
}
