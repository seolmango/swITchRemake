import { Injectable, ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard, ThrottlerRequest } from "@nestjs/throttler";
import { RATE_LIMIT_KEY, RateLimitOptions } from "./ratelimiter.decorator";

@Injectable()
export class RateLimiterGuard extends ThrottlerGuard {
    protected async getTracker(req: Record<string, any>): Promise<string> {
        if (req.user && req.user.id) {
            return `user:${req.user.id}`;
        }
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
            user: 50,
            ttl: 60000,
        };

        const currentOptions = routeOptions || defaultOptions;

        requestProps.ttl = currentOptions.ttl;
        requestProps.limit = req.user ? currentOptions.user : currentOptions.anon;

        return super.handleRequest(requestProps)
    }
}