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
    count: number;
    violated: boolean;
    violationStreak: number;
    abusive: boolean;
    abusiveStreak: number;
}

/** Fixed windows are deliberate: cheap bounded work on the single-threaded hot path. */
export class AbuseRateLimiter {
    readonly #buckets = new Map<string, Bucket>();
    readonly #cooldowns = new Map<string, number>();
    readonly #now: () => number;

    public constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    public check(rule: string, subject: RateSubject, limit: number, windowMs: number, policy: RateCheckPolicy = {}): RateDecision {
        const now = this.#now();
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

    public releaseConnection(connectionId: number): void {
        const marker = `:connection:${connectionId}`;
        for (const key of this.#buckets.keys()) if (key.includes(marker)) this.#buckets.delete(key);
    }

    public prune(before: number): void {
        for (const [key, timestamp] of this.#cooldowns) if (timestamp < before) this.#cooldowns.delete(key);
    }

    #subjectKeys(rule: string, subject: RateSubject, scopes: readonly RateScope[] = ['connection', 'ip', 'user']): string[] {
        const keys: string[] = [];
        if (scopes.includes('connection')) keys.push(`${rule}:connection:${subject.connectionId}`);
        if (scopes.includes('ip')) keys.push(`${rule}:ip:${subject.ip}`);
        if (scopes.includes('user') && subject.userId !== undefined) keys.push(`${rule}:user:${subject.userId}`);
        return keys;
    }
}
