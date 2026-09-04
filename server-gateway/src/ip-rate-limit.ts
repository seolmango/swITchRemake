interface Bucket {
    readonly window: number;
    count: number;
}

/**
 * 공개 리플레이 요청이 upstream의 Redis 조회로 증폭되기 전에 자르는 작은 고정 창 limiter.
 *
 * 소켓에서 직접 본 IP를 키로 쓰므로 클라이언트 헤더로 새 버킷을 만들 수 없다. 서로 다른 IP로
 * 지도 자체를 채우는 경우에도 새 항목을 fail-closed로 막아 게이트웨이 메모리에 상한을 둔다.
 */
export class IpRateLimiter {
    readonly #buckets = new Map<string, Bucket>();
    readonly #now: () => number;
    readonly #maxSubjects: number;
    #lastWindow = -1;

    public constructor(now: () => number = Date.now, maxSubjects = 100_000) {
        this.#now = now;
        this.#maxSubjects = maxSubjects;
    }

    public allow(ip: string, limit: number, windowMs: number): boolean {
        const window = Math.floor(this.#now() / windowMs);
        if (window !== this.#lastWindow) {
            for (const [key, bucket] of this.#buckets) {
                if (bucket.window !== window) this.#buckets.delete(key);
            }
            this.#lastWindow = window;
        }
        let bucket = this.#buckets.get(ip);
        if (bucket === undefined) {
            if (this.#buckets.size >= this.#maxSubjects) return false;
            bucket = { window, count: 0 };
            this.#buckets.set(ip, bucket);
        }
        bucket.count += 1;
        return bucket.count <= limit;
    }
}
