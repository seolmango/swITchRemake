import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TTL_MS, PROTOCOL_VERSION, makeKeys, type MatchServerHeartbeat } from 'shared';
import { RedisService } from '../redis/redis.service';
import { RoomsService } from '../rooms/rooms.service';

/** 초 단위 링버퍼. 60칸이면 "최근 1분"이 나눗셈 없이 나온다. */
const WINDOW_SECONDS = 60;

/**
 * 이 매칭 서버 인스턴스가 얼마나 받고 있는지 세어 Redis에 알린다.
 *
 * **요청마다 Redis를 두드리지 않는다.** 그러면 측정이 곧 부하가 되고, 트래픽이 늘수록 측정
 * 비용도 같이 늘어 정작 바쁠 때 서버를 더 밀어붙인다. 프로세스 안에서 세고 2초마다 한 번만 쓴다.
 *
 * 인게임 서버의 heartbeat와 같은 주기·TTL을 쓴다. 갱신이 멈추면 키가 스스로 사라지므로,
 * 죽은 인스턴스가 운영자 화면에 영원히 남지 않는다.
 */
@Injectable()
export class RequestMeterService implements OnModuleInit, OnModuleDestroy {
    private readonly keys = makeKeys(process.env.APP_ENV ?? 'dev');
    private readonly instanceId = process.env.MATCH_SERVER_ID?.trim()
        || `match-${process.pid}`;
    private readonly buckets = new Int32Array(WINDOW_SECONDS);
    private cursor = 0;
    private cursorSecond = Math.floor(Date.now() / 1000);
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private readonly redis: RedisService,
        private readonly rooms: RoomsService,
    ) {}

    onModuleInit(): void {
        if (this.timer !== null) return;
        this.timer = setInterval(() => { void this.publish(); }, HEARTBEAT_INTERVAL_MS);
        this.timer.unref();
    }

    onModuleDestroy(): void {
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
    }

    /** 요청 하나. 인터셉터가 부른다 — 여기서 하는 일은 정수 증가 하나여야 한다. */
    record(now = Date.now()): void {
        this.advance(Math.floor(now / 1000));
        this.buckets[this.cursor] += 1;
    }

    requestsPerMinute(now = Date.now()): number {
        this.advance(Math.floor(now / 1000));
        let total = 0;
        for (const value of this.buckets) total += value;
        return total;
    }

    /** 지난 칸들을 0으로 밀고 커서를 옮긴다. 한참 쉬었다면 창 전체를 비운다. */
    private advance(second: number): void {
        if (second <= this.cursorSecond) return;
        const elapsed = second - this.cursorSecond;
        if (elapsed >= WINDOW_SECONDS) {
            this.buckets.fill(0);
            this.cursor = 0;
        } else {
            for (let step = 0; step < elapsed; step += 1) {
                this.cursor = (this.cursor + 1) % WINDOW_SECONDS;
                this.buckets[this.cursor] = 0;
            }
        }
        this.cursorSecond = second;
    }

    private async publish(): Promise<void> {
        const now = Date.now();
        const heartbeat: MatchServerHeartbeat = {
            instanceId: this.instanceId,
            buildVersion: process.env.BUILD_ID?.trim() || 'dev',
            protocolVersion: PROTOCOL_VERSION,
            requestsPerMinute: this.requestsPerMinute(now),
            pendingCommands: this.rooms.pendingCommandCount(),
            updatedAt: now,
        };
        try {
            await this.redis.set(
                this.keys.matchServer(this.instanceId),
                JSON.stringify(heartbeat),
                Math.ceil(HEARTBEAT_TTL_MS / 1_000),
            );
            await this.redis.addToSortedSet(this.keys.matchServersAlive(), now, this.instanceId);
            await this.redis.removeFromSortedSetByScore(
                this.keys.matchServersAlive(),
                Number.NEGATIVE_INFINITY,
                now - HEARTBEAT_TTL_MS,
            );
        } catch {
            // Redis가 흔들렸다고 매칭 서버가 죽을 이유는 없다. 다음 주기에 다시 쓴다.
        }
    }
}
