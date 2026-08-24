import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AccountGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const user = context.switchToHttp().getRequest().user;
        if (!user) throw new UnauthorizedException('An account session is required');
        if (user.guest !== false || !Number.isInteger(user.id) || typeof user.sessionId !== 'string' || !UUID_V4.test(user.sessionId)) {
            throw new ForbiddenException('This endpoint requires an account');
        }
        return true;
    }
}
