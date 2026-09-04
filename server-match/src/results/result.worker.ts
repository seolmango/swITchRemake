import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
    CONTROL_VERSION,
    CommandType,
    ConsumerGroup,
    makeKeys,
    type ControlCommand,
    type GrantMatchPayload,
    type MatchResultMessage,
} from 'shared';
import { RedisService, type StreamEntry } from '../redis/redis.service';
import { CONTROL_STREAM_FIELDS, encodeCommand } from '../rooms/control-stream.codec';
import { decodeMatchResult, RESULT_STREAM_FIELD } from './result.codec';
import { ResultService } from './result.service';

const PENDING_IDLE_MS = 30_000;
/**
 * 발급 명령의 만료. 인게임 서버는 이 시각을 넘겨 도착한 명령을 부수 효과 없이 버린다.
 * 결과창이 30초라 그 안에 닿으면 방장이 기다릴 일이 없다.
 */
const GRANT_DEADLINE_MS = 15_000;

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
        if (outcome === 'stored') await this.grantNextMatch(result);
        await this.ack(entry.id);
    }

    /**
     * 다음 경기를 발급해 방을 소유한 인게임 서버에 내려보낸다.
     *
     * 인게임 서버는 발급받은 id로만 경기를 시작할 수 있으므로, 이것이 재경기의 유일한 통로다.
     * 응답을 기다리지 않는다 — 명령 stream은 소비자가 처리한 뒤 ack하므로 잠깐 늦을 수는 있어도
     * 그냥 사라지지 않고, 기다려 봐야 이 worker가 다음 결과를 못 읽을 뿐이다.
     *
     * 발급이나 전달이 실패해도 결과 저장은 이미 끝났다. 되돌리지 않고 로그만 남긴다. 그 방은
     * 다음 경기를 시작하지 못한 채 남는데, 이미 저장된 전적을 지우는 것보다는 낫다.
     */
    private async grantNextMatch(result: MatchResultMessage): Promise<void> {
        try {
            const matchId = await this.results.issueNextMatch(result);
            if (!matchId) return;
            const command: ControlCommand<GrantMatchPayload> = {
                v: CONTROL_VERSION,
                requestId: randomUUID(),
                type: CommandType.GrantMatch,
                issuedAt: Date.now(),
                deadlineAt: Date.now() + GRANT_DEADLINE_MS,
                // 응답을 기다리지 않으므로 읽는 사람이 없는 곳으로 보낸다. 이 worker에는 자기
                // 응답 stream이 없고, 만들어 봐야 아무도 그 답으로 할 일이 없다.
                replyTo: this.keys.replies(),
                payload: { roomId: result.roomId, matchId },
            };
            await this.redis.addStreamEntry(
                this.keys.commands(result.serverId),
                CONTROL_STREAM_FIELDS.command,
                encodeCommand(command),
            );
        } catch (error) {
            this.logger.error(`Failed to grant the next match for room ${result.roomId}`, error);
        }
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
