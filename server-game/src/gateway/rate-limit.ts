export type RateSubject = {
    connectionId: number;
    ip: string;
    userId?: number | string;
};

export interface RateDecision {
    allowed: boolean;
    /** Three consecutive windows exceeded the rule. */
    persistent: boolean;
}

interface Bucket {
    window: number;
    count: number;
    violated: boolean;
    violationStreak: number;
}

/** Fixed windows are deliberate: cheap bounded work on the single-threaded hot path. */
export class AbuseRateLimiter {
    readonly #buckets = new Map<string, Bucket>();
    readonly #cooldowns = new Map<string, number>();
    readonly #now: () => number;

    public constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    public check(rule: string, subject: RateSubject, limit: number, windowMs: number): RateDecision {
        const now = this.#now();
        const window = Math.floor(now / windowMs);
        let allowed = true;
        let persistent = false;
        for (const key of this.#subjectKeys(rule, subject)) {
            let bucket = this.#buckets.get(key);
            if (bucket === undefined || bucket.window !== window) {
                const previous = bucket;
                const consecutive = previous !== undefined && previous.violated && previous.window === window - 1;
                bucket = { window, count: 0, violated: false, violationStreak: consecutive ? previous.violationStreak : 0 };
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
        }
        return { allowed, persistent };
    }

    public cooldown(rule: string, subject: RateSubject, cooldownMs: number): RateDecision {
        const now = this.#now();
        let allowed = true;
        for (const key of this.#subjectKeys(rule, subject).filter((key) => !key.includes(':connection:'))) {
            const permittedAt = this.#cooldowns.get(key) ?? 0;
            if (permittedAt > now) allowed = false;
        }
        if (allowed) {
            for (const key of this.#subjectKeys(rule, subject).filter((key) => !key.includes(':connection:'))) {
                this.#cooldowns.set(key, now + cooldownMs);
            }
        }
        return { allowed, persistent: false };
    }

    public releaseConnection(connectionId: number): void {
        const marker = `:connection:${connectionId}`;
        for (const key of this.#buckets.keys()) if (key.includes(marker)) this.#buckets.delete(key);
    }

    public prune(before: number): void {
        for (const [key, timestamp] of this.#cooldowns) if (timestamp < before) this.#cooldowns.delete(key);
    }

    #subjectKeys(rule: string, subject: RateSubject): string[] {
        const keys = [`${rule}:connection:${subject.connectionId}`, `${rule}:ip:${subject.ip}`];
        if (subject.userId !== undefined) keys.push(`${rule}:user:${subject.userId}`);
        return keys;
    }
}
