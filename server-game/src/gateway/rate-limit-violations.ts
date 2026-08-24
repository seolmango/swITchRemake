import { ViolationKind, type ViolationSignal } from 'shared';
import type { ViolationSink } from './message-router';

interface Aggregate {
    signal: ViolationSignal;
    count: number;
    firstAt: number;
    lastAt: number;
    severity: ViolationSignal['severity'];
}

const severityRank: Record<ViolationSignal['severity'], number> = { low: 0, medium: 1, high: 2 };

/** Coalesces the packet hot path into one diagnostic signal per connection/rule/interval. */
export class RateLimitViolationAggregator {
    readonly #aggregates = new Map<string, Aggregate>();
    readonly #sink: ViolationSink;
    readonly #now: () => number;

    public constructor(sink: ViolationSink, now: () => number = Date.now) {
        this.#sink = sink;
        this.#now = now;
    }

    public record(connectionId: number, ip: string, rule: string, signal: ViolationSignal): void {
        const key = `${connectionId}:${rule}`;
        const now = this.#now();
        const existing = this.#aggregates.get(key);
        if (existing === undefined) {
            this.#aggregates.set(key, {
                signal: { ...signal, detail: { ...signal.detail, ip } },
                count: 1,
                firstAt: now,
                lastAt: now,
                severity: signal.severity,
            });
            return;
        }
        existing.count += 1;
        existing.lastAt = now;
        if (severityRank[signal.severity] > severityRank[existing.severity]) existing.severity = signal.severity;
        existing.signal = { ...signal, detail: { ...signal.detail, ip } };
    }

    public flushReady(intervalMs: number): void {
        const now = this.#now();
        for (const [key, aggregate] of this.#aggregates) {
            if (now - aggregate.firstAt >= intervalMs) this.#flush(key, aggregate);
        }
    }

    public flushConnection(connectionId: number): void {
        const prefix = `${connectionId}:`;
        for (const [key, aggregate] of this.#aggregates) {
            if (key.startsWith(prefix)) this.#flush(key, aggregate);
        }
    }

    public flushAll(): void {
        for (const [key, aggregate] of this.#aggregates) this.#flush(key, aggregate);
    }

    #flush(key: string, aggregate: Aggregate): void {
        const separator = key.indexOf(':');
        const connectionId = Number(key.slice(0, separator));
        const rule = key.slice(separator + 1);
        this.#sink({
            ...aggregate.signal,
            kind: ViolationKind.RateLimit,
            severity: aggregate.severity,
            detail: {
                ...aggregate.signal.detail,
                subject: `connection:${connectionId}`,
                rule,
                count: aggregate.count,
                durationMs: Math.max(0, aggregate.lastAt - aggregate.firstAt),
            },
        });
        this.#aggregates.delete(key);
    }
}
