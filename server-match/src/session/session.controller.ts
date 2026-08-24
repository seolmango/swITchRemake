import { Controller, Delete, Get, Param, ParseUUIDPipe, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyReply, FastifyRequest } from 'fastify';
import { NeedAccount } from '../auth/need-account.decorator';
import { SessionService } from './session.service';

type AuthenticatedRequest = FastifyRequest & {
    user: { id: number; sessionId: string };
};

@Controller('users/me/sessions')
@NeedAccount()
export class SessionController {
    constructor(
        private readonly sessionService: SessionService,
        private readonly configService: ConfigService,
    ) {}

    @Get()
    async list(@Req() req: AuthenticatedRequest) {
        await this.sessionService.assertOwnedActiveSession(req.user.id, req.user.sessionId);
        return {
            sessions: await this.sessionService.list(req.user.id, req.user.sessionId),
        };
    }

    @Delete('others')
    async revokeOthers(@Req() req: AuthenticatedRequest) {
        await this.sessionService.assertOwnedActiveSession(req.user.id, req.user.sessionId);
        const revokedCount = await this.sessionService.revokeOthers(req.user.id, req.user.sessionId);
        return { revokedCount };
    }

    @Delete(':sessionId')
    async revoke(
        @Req() req: AuthenticatedRequest,
        @Res({ passthrough: true }) res: FastifyReply,
        @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
    ) {
        const current = sessionId === req.user.sessionId;
        if (!current) {
            await this.sessionService.assertOwnedActiveSession(req.user.id, req.user.sessionId);
        }
        await this.sessionService.revoke(req.user.id, sessionId);
        if (current) {
            res.clearCookie('refreshToken', this.cookieOptions());
        }
        return { revoked: true, current };
    }

    private cookieOptions() {
        return {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict' as const,
            path: '/',
            signed: true,
            maxAge: Number(this.configService.get('JWT_REFRESH_EXPIRATION')),
        };
    }
}
