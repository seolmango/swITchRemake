/**
 * Redis의 인게임 서버 목록을 읽어 들고 있는 캐시.
 *
 * 요청마다 Redis를 두드리지 않는 이유는, 이 값이 heartbeat 주기(2초)로만 바뀌는데 WebSocket
 * 업그레이드는 그보다 훨씬 자주 오기 때문이다. 매번 물으면 게이트웨이가 Redis 왕복만큼 느려진다.
 *
 * 대신 **정적 설정 파일을 두지 않는다.** 서버가 늘고 줄 때 아무도 설정을 고치지 않아도 되는
 * 것이 이 구조의 요점이다. 뜨면 알아서 경로가 생기고, 죽으면 TTL로 사라진다.
 */

import type Redis from 'ioredis';
import { HEARTBEAT_INTERVAL_MS, type GameServerHeartbeat, type RedisKeys } from 'shared';

export interface RegistryViewOptions {
    readonly redis: Redis;
    readonly keys: RedisKeys;
    readonly refreshMs?: number;
    readonly logger?: (message: string, error?: unknown) => void;
}

export class RegistryView {
    readonly #options: RegistryViewOptions;
    readonly #refreshMs: number;
    #servers: ReadonlyMap<string, GameServerHeartbeat> = new Map();
    #timer: NodeJS.Timeout | null = null;

    public constructor(options: RegistryViewOptions) {
        this.#options = options;
        this.#refreshMs = options.refreshMs ?? HEARTBEAT_INTERVAL_MS;
    }

    public get servers(): ReadonlyMap<string, GameServerHeartbeat> {
        return this.#servers;
    }

    public async start(): Promise<void> {
        await this.refresh();
        this.#timer = setInterval(() => { void this.refresh(); }, this.#refreshMs);
        this.#timer.unref();
    }

    public stop(): void {
        if (this.#timer !== null) clearInterval(this.#timer);
        this.#timer = null;
    }

    /**
     * 한 번 훑는다.
     *
     * 실패하면 **직전 목록을 그대로 둔다.** Redis가 잠깐 흔들렸다고 라우팅 표를 비우면, 멀쩡히
     * 돌고 있는 경기의 재접속이 전부 502가 된다. 목록이 조금 낡는 편이 훨씬 낫다.
     */
    public async refresh(): Promise<void> {
        try {
            const ids = await this.#options.redis.zrange(this.#options.keys.gameServersAlive(), 0, -1);
            const entries = await Promise.all(ids.map(async (id) => {
                const raw = await this.#options.redis.get(this.#options.keys.gameServer(id));
                if (raw === null) return null;
                try {
                    const value = JSON.parse(raw) as GameServerHeartbeat;
                    return value.serverId === id ? ([id, value] as const) : null;
                } catch {
                    return null;
                }
            }));
            this.#servers = new Map(entries.filter((entry): entry is readonly [string, GameServerHeartbeat] => entry !== null));
        } catch (error: unknown) {
            this.#options.logger?.('게임 서버 목록을 갱신하지 못했습니다. 직전 목록을 유지합니다.', error);
        }
    }
}
