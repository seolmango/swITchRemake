import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConsumerGroup, makeKeys } from 'shared';
import { RedisService, type StreamEntry } from '../redis/redis.service';
import { decodeMatchResult, RESULT_STREAM_FIELD } from './result.codec';
import { ResultService } from './result.service';

const PENDING_IDLE_MS = 30_000;

@Injectable()
export class ResultWorker implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ResultWorker.name);
    private readonly keys = makeKeys(process.env.APP_ENV ?? 'dev');
    private readonly consumer = `result-${randomUUID()}`;
    private stopping = false;
    private retryMs = 50;

    constructor(private readonly redis: RedisService, private readonly results: ResultService) {}

    async onModuleInit(): Promise<void> {
        await this.redis.ensureConsumerGroup(this.keys.gameResults(), ConsumerGroup.Results, '0');
        void this.run();
    }

    onModuleDestroy(): void {
        this.stopping = true;
    }

    async processEntry(entry: StreamEntry): Promise<void> {
        const raw = entry.fields[RESULT_STREAM_FIELD];
        if (!raw) {
            this.logger.warn(`Discarding malformed result ${entry.id}: missing ${RESULT_STREAM_FIELD} field`);
            await this.ack(entry.id);
            return;
        }
        let result;
        try {
            result = decodeMatchResult(raw);
        } catch (error) {
            this.logger.warn(`Discarding malformed result ${entry.id}: ${this.message(error)}`);
            await this.ack(entry.id);
            return;
        }

        // record() resolves only after its database transaction commits. A
        // thrown/transient DB error intentionally leaves the entry pending.
        const outcome = await this.results.record(result);
        if (outcome === 'invalid') {
            this.logger.warn(`Discarding unauthorized or inconsistent result ${result.matchId}`);
        }
        await this.ack(entry.id);
    }

    private async run(): Promise<void> {
        while (!this.stopping) {
            try {
                const reclaimed = await this.redis.autoClaim(
                    this.keys.gameResults(), ConsumerGroup.Results, this.consumer, PENDING_IDLE_MS,
                );
                const fresh = await this.redis.readGroup(
                    this.keys.gameResults(), ConsumerGroup.Results, this.consumer, 1_000,
                );
                this.retryMs = 50;
                for (const entry of [...reclaimed, ...fresh]) {
                    try {
                        await this.processEntry(entry);
                    } catch (error) {
                        if (!this.stopping) this.logger.error(`Result ${entry.id} processing failed; leaving pending`, error);
                    }
                }
            } catch (error) {
                if (!this.stopping) {
                    this.logger.error('Result stream consume failed', error);
                    await this.waitForRetry();
                }
            }
        }
    }

    private ack(entryId: string): Promise<void> {
        return this.redis.acknowledge(this.keys.gameResults(), ConsumerGroup.Results, entryId);
    }

    private async waitForRetry(): Promise<void> {
        const delay = this.retryMs;
        this.retryMs = Math.min(this.retryMs * 2, 1_000);
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            timer.unref();
        });
    }

    private message(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
