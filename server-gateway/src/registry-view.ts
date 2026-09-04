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
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TTL_MS, type GameServerHeartbeat, type RedisKeys } from 'shared';

export interface BackendAddressPolicy {
    readonly allowedHosts: readonly string[];
    readonly allowedPortRanges: readonly { readonly min: number; readonly max: number }[];
}

export interface RegistryViewOptions {
    readonly redis: Redis;
    readonly keys: RedisKeys;
    readonly refreshMs?: number;
    readonly logger?: (message: string, error?: unknown) => void;
    readonly addressPolicy: BackendAddressPolicy;
    readonly now?: () => number;
}

const SERVER_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function integerIn(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function validInternalAddress(value: unknown, policy: BackendAddressPolicy): value is string {
    if (typeof value !== 'string' || value.length > 512) return false;
    try {
        const url = new URL(value);
        const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
        const port = Number(url.port);
        return url.protocol === 'http:'
            && url.username === ''
            && url.password === ''
            && url.pathname === '/'
            && url.search === ''
            && url.hash === ''
            && url.port !== ''
            && policy.allowedHosts.some((allowed) => allowed.toLowerCase() === host)
            && policy.allowedPortRanges.some((range) => Number.isInteger(port) && port >= range.min && port <= range.max);
    } catch {
        return false;
    }
}

/** Redis는 반신뢰 경계다. 이 검사를 통과한 값만 공개 요청의 네트워크 목적지가 된다. */
export function decodeHeartbeat(
    raw: string,
    expectedServerId: string,
    policy: BackendAddressPolicy,
    now: number,
): GameServerHeartbeat {
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed)
        || parsed['serverId'] !== expectedServerId
        || !SERVER_ID.test(expectedServerId)
        || !boundedText(parsed['buildVersion'], 128)
        || !integerIn(parsed['protocolVersion'], 1, 1_000_000)
        || !boundedText(parsed['rulesVersion'], 128)
        || !boundedText(parsed['mapBundleHash'], 128)
        || !integerIn(parsed['maxRooms'], 1, 100_000)
        || !integerIn(parsed['waitingRooms'], 0, parsed['maxRooms'] as number)
        || !integerIn(parsed['playingRooms'], 0, parsed['maxRooms'] as number)
        || (parsed['waitingRooms'] as number) + (parsed['playingRooms'] as number) > (parsed['maxRooms'] as number)
        || !integerIn(parsed['connections'], 0, 1_000_000)
        || typeof parsed['loopLagMs'] !== 'number'
        || !Number.isFinite(parsed['loopLagMs'])
        || parsed['loopLagMs'] < 0
        || parsed['loopLagMs'] > 60_000
        || typeof parsed['draining'] !== 'boolean'
        || !integerIn(parsed['updatedAt'], 0, Number.MAX_SAFE_INTEGER)
        || parsed['updatedAt'] < now - HEARTBEAT_TTL_MS
        || parsed['updatedAt'] > now + HEARTBEAT_INTERVAL_MS
        || !validInternalAddress(parsed['internalAddress'], policy)) {
        throw new Error(`invalid heartbeat for ${expectedServerId}`);
    }
    return parsed as unknown as GameServerHeartbeat;
}

export class RegistryView {
    readonly #options: RegistryViewOptions;
    readonly #refreshMs: number;
    readonly #now: () => number;
    #servers: ReadonlyMap<string, GameServerHeartbeat> = new Map();
    #timer: NodeJS.Timeout | null = null;

    public constructor(options: RegistryViewOptions) {
        this.#options = options;
        this.#refreshMs = options.refreshMs ?? HEARTBEAT_INTERVAL_MS;
        this.#now = options.now ?? Date.now;
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
                    const value = decodeHeartbeat(raw, id, this.#options.addressPolicy, this.#now());
                    return [id, value] as const;
                } catch (error: unknown) {
                    this.#options.logger?.(`올바르지 않은 heartbeat를 라우팅에서 제외합니다. serverId=${id}`, error);
                    return null;
                }
            }));
            this.#servers = new Map(entries.filter((entry): entry is readonly [string, GameServerHeartbeat] => entry !== null));
        } catch (error: unknown) {
            this.#options.logger?.('게임 서버 목록을 갱신하지 못했습니다. 직전 목록을 유지합니다.', error);
        }
    }
}
