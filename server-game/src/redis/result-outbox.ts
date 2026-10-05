import { HEARTBEAT_INTERVAL_MS, type MatchResultMessage, type RedisKeys } from 'shared';
import { NETWORK } from '../config/network';
import type { RedisPort } from './redis-client';
import { ResultJournal } from './result-journal';
import { randomUUID } from 'node:crypto';

export const RESULT_STREAM_FIELD = 'result';

export interface ResultOutboxOptions {
    readonly redis: RedisPort;
    readonly keys: RedisKeys;
    readonly maxEntries?: number;
    readonly logger?: (message: string, error?: unknown) => void;
    readonly journalDirectory?: string;
    readonly isPersisted?: (result: MatchResultMessage) => Promise<boolean>;
}

/** 영속 모드에서는 DB 저장 확인까지 결과를 공유 디스크에 보존한다. */
export class ResultOutbox {
    readonly #options: ResultOutboxOptions;
    readonly #maxEntries: number;
    readonly #logger: NonNullable<ResultOutboxOptions['logger']>;
    readonly #queue: MatchResultMessage[] = [];
    readonly #journal: ResultJournal | null;
    #journalFailed = false;
    #flushing: Promise<number> | null = null;
    #timer: NodeJS.Timeout | null = null;

    public constructor(options: ResultOutboxOptions) {
        this.#options = options;
        this.#maxEntries = options.maxEntries ?? NETWORK.STREAM_MAXLEN;
        this.#logger = options.logger ?? (() => undefined);
        if (!Number.isInteger(this.#maxEntries) || this.#maxEntries < 1) throw new Error('outbox maxEntries must be positive');
        if (options.journalDirectory !== undefined && options.isPersisted === undefined) {
            throw new Error('durable result outbox requires a database acknowledgement');
        }
        this.#journal = options.journalDirectory === undefined ? null : new ResultJournal(options.journalDirectory);
        // Corrupt existing data must prevent this worker from admitting new games.
        this.#journal?.entries(Number.MAX_SAFE_INTEGER);
    }

    public get size(): number { return this.#queue.length + (this.#journal?.count() ?? 0); }

    public start(): void {
        if (this.#timer !== null) return;
        this.#timer = setInterval(() => { void this.flush(); }, HEARTBEAT_INTERVAL_MS);
        this.#timer.unref();
        void this.flush();
    }

    public stop(): void {
        if (this.#timer !== null) clearInterval(this.#timer);
        this.#timer = null;
    }

    /** false면 신규 게임 시작을 막아 더 많은 유실 가능 결과를 만들지 않는다. */
    public canStartNewGame(): boolean {
        try { return !this.#journalFailed && this.size < this.#maxEntries; }
        catch (error) {
            this.#journalFailed = true;
            this.#logger('Result journal unavailable; block new game starts', error);
            return false;
        }
    }

    public enqueue(result: MatchResultMessage): void {
        if (this.#journal !== null) {
            // Keep failed disk writes in memory for retry and stop admitting new games.
            // Already running games may finish beyond the admission threshold.
            this.#queue.push(result);
            try { this.#persistPending(); }
            catch (error) { this.#journalFailed = true; throw error; }
            return;
        }
        if (this.#queue.length >= this.#maxEntries) {
            const error = new Error(`result outbox capacity exceeded (${this.#maxEntries})`);
            this.#logger('Result outbox is full; block new game starts', error);
            throw error;
        }
        this.#queue.push(result);
    }

    /** 동시 flush 호출은 같은 작업을 기다려 순서를 뒤집지 않는다. */
    public flush(): Promise<number> {
        if (this.#flushing !== null) return this.#flushing;
        this.#flushing = this.#flushOnce().finally(() => { this.#flushing = null; });
        return this.#flushing;
    }

    async #flushOnce(): Promise<number> {
        if (this.#journal !== null) return this.#flushJournal();
        if (!this.#options.redis.isReady()) return 0;
        let sent = 0;
        while (this.#queue[sent] !== undefined) {
            const result = this.#queue[sent];
            try {
                await this.#options.redis.xAdd(
                    this.#options.keys.gameResults(),
                    RESULT_STREAM_FIELD,
                    JSON.stringify(result),
                    NETWORK.STREAM_MAXLEN,
                );
            } catch (error: unknown) {
                this.#logger('Redis result flush failed; result remains in memory outbox', error);
                break;
            }
            sent += 1;
        }
        // Array.shift()는 뒤 원소를 매번 당겨 대량 복구가 O(n²)이 된다. 성공한 접두사를
        // 한 번만 제거하면 순서와 실패 시 보존 성질은 같고, 큐 정리는 O(n) 한 번으로 끝난다.
        if (sent > 0) this.#queue.splice(0, sent);
        return sent;
    }

    #persistPending(): void {
        if (this.#journal === null) return;
        while (this.#queue[0] !== undefined) {
            this.#journal.append(this.#queue[0]);
            this.#queue.shift();
        }
    }

    async #flushJournal(): Promise<number> {
        let entries: MatchResultMessage[];
        try {
            this.#persistPending();
            entries = this.#journal!.entries();
            this.#journalFailed = false;
        } catch (error) {
            this.#journalFailed = true;
            this.#logger('Result journal unavailable; retain pending results and block new games', error);
            return 0;
        }
        if (!this.#options.redis.isReady()) return 0;
        let sent = 0;
        for (const result of entries) {
            const leaseKey = this.#options.keys.operation(`result-publish:${result.matchId}`);
            const token = randomUUID();
            try {
                if (await this.#options.isPersisted!(result)) {
                    this.#journal!.acknowledge(result.matchId);
                    continue;
                }
                // Shared retry throttle, even when a new worker adopts an old journal.
                if (!await this.#options.redis.setPxIfAbsent(leaseKey, token, 30_000)) continue;
                try {
                    await this.#options.redis.xAdd(this.#options.keys.gameResults(), RESULT_STREAM_FIELD,
                        JSON.stringify(result), NETWORK.STREAM_MAXLEN);
                } catch (error) {
                    await this.#options.redis.compareAndDelete(leaseKey, token).catch(() => undefined);
                    throw error;
                }
                sent += 1;
            } catch (error) {
                this.#logger('Result delivery failed; durable journal retained', error);
                break;
            }
        }
        return sent;
    }
}
