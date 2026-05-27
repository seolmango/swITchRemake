import { Injectable, CanActivate, ExecutionContext, UnauthorizedException} from "@nestjs/common";

@Injectable()
export class LoggedInGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest();

        if (!request.user) {
            throw new UnauthorizedException("You are not logged in.");
        }
        return true;
    }
}