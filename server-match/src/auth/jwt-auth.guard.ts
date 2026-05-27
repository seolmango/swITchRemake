import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtAuthGuard implements CanActivate {
    constructor(
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
    ) {}
    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const authHeader = request.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return true;
        }

        const token = authHeader.split(' ')[1];

        try {
            const payload = this.jwtService.verify(token, {
                secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
            })

            request.user = {
                id: payload.sub,
            }

            return true;
        } catch (e) {
            throw new UnauthorizedException('Invalid token');
        }
    }
}