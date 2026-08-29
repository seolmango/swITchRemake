import { Injectable, ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard, ThrottlerRequest } from "@nestjs/throttler";
import { RATE_LIMIT_KEY, RateLimitOptions } from "./ratelimiter.decorator";

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

export function rateLimitRelaxed(): boolean {
    return process.env.RATE_LIMIT_RELAXED === 'true';
}

/** 완화 플래그가 운영에 딸려 들어가는 것을 부팅에서 막는다. */
export function assertRateLimitPolicy(appEnv: string | undefined): void {
    if (rateLimitRelaxed() && appEnv === 'prod') {
        throw new Error('RATE_LIMIT_RELAXED=true is not allowed when APP_ENV=prod. Unset it.');
    }
}

@Injectable()
export class RateLimiterGuard extends ThrottlerGuard {
    protected async getTracker(req: Record<string, any>): Promise<string> {
        if (req.user?.guest === true) return `guest:${req.user.id}`;
        if (req.user?.guest === false) return `account:${req.user.id}`;
        return `ip:${req.ip}`;
    }

    protected async handleRequest(requestProps:ThrottlerRequest): Promise<boolean> {
        const { context } = requestProps;
        const req = context.switchToHttp().getRequest();

        const routeOptions = this.reflector.get<RateLimitOptions>(
            RATE_LIMIT_KEY,
            context.getHandler(),
        ) || this.reflector.get<RateLimitOptions>(
            RATE_LIMIT_KEY,
            context.getClass(),
        );

        const defaultOptions: RateLimitOptions = {
            anon: 20,
            guest: 30,
            account: 50,
            ttl: 60000,
        };

        const currentOptions = routeOptions || defaultOptions;

        const limit = req.user?.guest === true
            ? currentOptions.guest
            : req.user?.guest === false
                ? currentOptions.account
                : currentOptions.anon;

        requestProps.ttl = currentOptions.ttl;
        // 0은 "이 신원에게는 아예 막힌 길"이라는 뜻이다. 완화해도 열리면 안 된다.
        requestProps.limit = limit > 0 && rateLimitRelaxed() ? limit * RATE_LIMIT_RELAXED_FACTOR : limit;

        return super.handleRequest(requestProps)
    }
}
