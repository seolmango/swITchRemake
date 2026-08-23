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
                secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
            })

            if (payload.type !== 'access') throw new UnauthorizedException('Invalid token');

            if (payload.guest === true) {
                if (
                    typeof payload.sub !== 'string'
                    || !/^g:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.sub)
                    || typeof payload.nickname !== 'string'
                    || !/^Guest_[A-HJ-NP-Z2-9]{6}$/.test(payload.nickname)
                ) {
                    throw new UnauthorizedException('Invalid token');
                }
                request.user = { id: payload.sub, nickname: payload.nickname, guest: true };
            } else {
                if (
                    !Number.isInteger(payload.sub)
                    || typeof payload.sid !== 'string'
                    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.sid)
                ) {
                    throw new UnauthorizedException('Invalid token');
                }
                request.user = { id: payload.sub, sessionId: payload.sid, guest: false };
            }

            return true;
        } catch (error: any) {
            if (error.name === 'TokenExpiredError') {
                throw new UnauthorizedException('Token expired');
            }

            throw new UnauthorizedException('Invalid token');
        }
    }
}
