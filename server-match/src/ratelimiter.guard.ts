import { Injectable, ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard, ThrottlerRequest } from "@nestjs/throttler";
import { RATE_LIMIT_KEY, RateLimitOptions } from "./ratelimiter.decorator";

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

        requestProps.ttl = currentOptions.ttl;
        requestProps.limit = req.user?.guest === true
            ? currentOptions.guest
            : req.user?.guest === false
                ? currentOptions.account
                : currentOptions.anon;

        return super.handleRequest(requestProps)
    }
}
