import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from '@nestjs/config';
import { makeKeys } from 'shared';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
    private readonly keys = makeKeys(process.env.APP_ENV ?? 'dev');
    constructor(
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
        private readonly redisService: RedisService,
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

            if (payload.guest === true) {
                if (
                    payload.type !== 'guest-access'
                    ||
                    typeof payload.sub !== 'string'
                    || !/^g:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.sub)
                    || typeof payload.sid !== 'string'
                    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.sid)
                    || typeof payload.nickname !== 'string'
                    || !/^Guest_[A-HJ-NP-Z2-9]{6}$/.test(payload.nickname)
                ) {
                    throw new UnauthorizedException('Invalid token');
                }
                request.user = { id: payload.sub, nickname: payload.nickname, sessionId: payload.sid, guest: true };
                if (!await this.redisService.get(this.keys.guestSession(payload.sid))) {
                    throw new UnauthorizedException('Guest session expired');
                }
            } else {
                if (
                    payload.type !== 'access'
                    ||
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
