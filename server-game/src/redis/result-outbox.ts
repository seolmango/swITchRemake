import { HEARTBEAT_INTERVAL_MS, type MatchResultMessage, type RedisKeys } from 'shared';
import { NETWORK } from '../config/network';
import type { RedisPort } from './redis-client';

export const RESULT_STREAM_FIELD = 'result';

export interface ResultOutboxOptions {
    readonly redis: RedisPort;
    readonly keys: RedisKeys;
    readonly maxEntries?: number;
    readonly logger?: (message: string, error?: unknown) => void;
}

/** Redis 장애 동안 경기 결과를 프로세스 메모리에 보존하고 복구 순서대로 flush한다. */
export class ResultOutbox {
    readonly #options: ResultOutboxOptions;
    readonly #maxEntries: number;
    readonly #logger: NonNullable<ResultOutboxOptions['logger']>;
    readonly #queue: MatchResultMessage[] = [];
    #flushing: Promise<number> | null = null;
    #timer: NodeJS.Timeout | null = null;

    public constructor(options: ResultOutboxOptions) {
        this.#options = options;
        this.#maxEntries = options.maxEntries ?? NETWORK.STREAM_MAXLEN;
        this.#logger = options.logger ?? (() => undefined);
        if (!Number.isInteger(this.#maxEntries) || this.#maxEntries < 1) throw new Error('outbox maxEntries must be positive');
    }

    public get size(): number { return this.#queue.length; }

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
    public canStartNewGame(): boolean { return this.#queue.length < this.#maxEntries; }

    public enqueue(result: MatchResultMessage): void {
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
}
