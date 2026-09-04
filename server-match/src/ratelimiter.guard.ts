import {
    CanActivate,
    ExecutionContext,
    HttpException,
    HttpStatus,
    Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RATE_LIMIT_KEY, RateLimitOptions } from './ratelimiter.decorator';
import { RedisService } from './redis/redis.service';
import { SessionSecurityService } from './session/session-security.service';

/**
 * 자동 점검용 완화 배수.
 *
 * 브라우저 자동 점검은 한 IP에서 몇십 개의 계정을 만들고 지운다. `/auth/verify`가 IP당 분당
 * 5회라 그 흐름은 원래 한도 안에서 끝날 수가 없다 — 그렇다고 한도를 유지한 채 점검을 포기하면,
 * 정작 사용자가 지나는 길을 아무도 안 밟아 보게 된다.
 *
 * **끄는 것이 아니라 넓히는 것**이다. 가드는 그대로 돌고 한도만 커진다. 그리고 `APP_ENV=prod`
 * 에서는 부팅이 거부된다(`assertRateLimitPolicy`). `EMAIL_TRANSPORT=sink`와 같은 취급이다.
 */
export const RATE_LIMIT_RELAXED_FACTOR = 50;
const NAT_IP_FACTOR = 4;

export function rateLimitRelaxed(): boolean {
    return process.env.RATE_LIMIT_RELAXED === 'true';
}

/** 완화 플래그가 운영에 딸려 들어가는 것을 부팅에서 막는다. */
export function assertRateLimitPolicy(appEnv: string | undefined): void {
    if (rateLimitRelaxed() && appEnv === 'prod') {
        throw new Error('RATE_LIMIT_RELAXED=true is not allowed when APP_ENV=prod. Unset it.');
    }
}

const DEFAULT_OPTIONS: RateLimitOptions = { anon: 20, guest: 30, account: 50, ttl: 60_000 };

abstract class RedisRateGuard {
    constructor(
        protected readonly reflector: Reflector,
        protected readonly redis: RedisService,
    ) {}

    protected options(context: ExecutionContext): RateLimitOptions {
        return this.reflector.get<RateLimitOptions>(RATE_LIMIT_KEY, context.getHandler())
            ?? this.reflector.get<RateLimitOptions>(RATE_LIMIT_KEY, context.getClass())
            ?? DEFAULT_OPTIONS;
    }

    protected scaled(limit: number): number {
        return limit > 0 && rateLimitRelaxed() ? limit * RATE_LIMIT_RELAXED_FACTOR : limit;
    }

    protected async consume(key: string, limit: number, ttlMs: number): Promise<void> {
        if (limit <= 0) {
            throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
        }
        const count = await this.redis.incrementWithTtl(key, Math.max(1, Math.ceil(ttlMs / 1000)));
        if (count > this.scaled(limit)) {
            throw new HttpException({
                statusCode: HttpStatus.TOO_MANY_REQUESTS,
                message: 'Too many requests',
                retryAfterMs: Math.max(0, await this.redis.ttlMilliseconds(key)),
            }, HttpStatus.TOO_MANY_REQUESTS);
        }
    }
}

/**
 * JWT 검증보다 먼저 IP 비용을 센다. 잘못된 서명도 이 버킷을 지나므로 검증 CPU를 공짜로 쓸 수 없다.
 * NAT 사용자를 위해 actor 한도보다 넓게 잡지만, actor가 생겨도 이 버킷을 없애지는 않는다.
 */
@Injectable()
export class PreAuthIpRateLimiterGuard extends RedisRateGuard {
    constructor(
        reflector: Reflector,
        redis: RedisService,
        private readonly security: SessionSecurityService,
    ) {
        super(reflector, redis);
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<Record<string, any>>();
        const options = this.options(context);
        const widestActorLimit = Math.max(options.anon, options.guest, options.account);
        await this.consume(
            `auth-rate:ip:${this.security.hmacIp(String(req.ip))}`,
            widestActorLimit * NAT_IP_FACTOR,
            options.ttl,
        );
        return true;
    }
}

/** JWT 뒤에서 actor와 공격 대상 계정을 각각 센다. 카운터는 모든 인스턴스가 같은 Redis를 쓴다. */
@Injectable()
export class RateLimiterGuard extends RedisRateGuard {
    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<Record<string, any>>();
        const options = this.options(context);
        const actorLimit = req.user?.guest === true
            ? options.guest
            : req.user?.guest === false
                ? options.account
                : options.anon;

        if (req.user) {
            const kind = req.user.guest ? 'guest' : 'account';
            await this.consume(`auth-rate:actor:${kind}:${req.user.id}`, actorLimit, options.ttl);
        }

        const target = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        if (target) {
            const positive = [options.anon, options.guest, options.account].filter((value) => value > 0);
            await this.consume(
                `auth-rate:target:${target}`,
                positive.length ? Math.min(...positive) : 0,
                options.ttl,
            );
        }
        return true;
    }
}
