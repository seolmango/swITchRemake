import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { UserService } from "./user.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { RateLimiter } from "../ratelimiter.decorator";
import { NeedAccount } from '../auth/need-account.decorator';
import { DeleteUserDto } from './dto/delete-user.dto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { ChangePasswordDto } from './dto/change-password.dto';
import { MatchHistoryQueryDto } from './dto/match-history-query.dto';
import { ReplayDownloadService } from './replay-download.service';
import { ConfigService } from '@nestjs/config';
import { refreshCookieOptions } from '../auth/refresh-cookie';
import { SessionSecurityService } from '../session/session-security.service';
import { auditContextWithIp } from '../admin/audit-log';
import { LegalConsentDto } from './dto/legal-consent.dto';

type AccountRequest = FastifyRequest & { user: { id: number; sessionId: string; guest: false } };

@Controller('users')
export class UserController {
    constructor(
        private readonly userService: UserService,
        private readonly replayDownload: ReplayDownloadService,
        private readonly configService: ConfigService,
        private readonly sessionSecurity: SessionSecurityService,
    ) {}

    @Post('register')
    @RateLimiter({ limit: 5, ttl: 60000 })
    async register(@Body() createUserDto: CreateUserDto) {
        return this.userService.createUser(createUserDto);
    }

    @Post('me/password')
    @NeedAccount()
    @RateLimiter({ limit: 5, ttl: 60000 })
    async changePassword(
        @Body() dto: ChangePasswordDto,
        @Req() req: AccountRequest,
    ) {
        return this.userService.changePassword(req.user.id, req.user.sessionId, dto);
    }

    @Get('me/stats')
    @NeedAccount()
    @RateLimiter({ limit: 60, ttl: 60_000 })
    async getMyStats(@Req() req: AccountRequest) {
        return this.userService.getStats(req.user.id);
    }

    @Get('me/matches')
    @NeedAccount()
    @RateLimiter({ limit: 60, ttl: 60_000 })
    async getMyMatches(
        @Req() req: AccountRequest,
        @Query() query: MatchHistoryQueryDto,
    ) {
        return this.userService.getMatches(req.user.id, query.limit, query.cursor);
    }

    @Get('me/legal-consent')
    @NeedAccount()
    @RateLimiter({ limit: 60, ttl: 60_000 })
    async getLegalConsent(@Req() req: AccountRequest) {
        return this.userService.getLegalConsent(req.user.id);
    }

    @Post('me/legal-consent')
    @NeedAccount()
    @RateLimiter({ limit: 5, ttl: 60_000 })
    async updateLegalConsent(@Req() req: AccountRequest, @Body() dto: LegalConsentDto) {
        return this.userService.updateLegalConsent(req.user.id, dto);
    }

    /**
     * 리플레이를 받아 갈 표를 끊는다.
     *
     * 파일을 여기서 흘려보내지 않는다 — 수백 KB가 매칭 서버를 통과할 이유가 없고, 파일은
     * 인게임 서버 디스크에 있다. 표만 주고 주소를 알려 준다.
     */
    @Post('me/matches/:matchId/replay-ticket')
    @NeedAccount()
    @RateLimiter({ limit: 20, ttl: 60_000 })
    async createReplayTicket(@Req() req: AccountRequest, @Param('matchId', new ParseUUIDPipe()) matchId: string) {
        return this.replayDownload.createTicket(req.user.id, matchId);
    }

    @Post('me/delete-code')
    @NeedAccount()
    @RateLimiter({ limit: 5, ttl: 60_000 })
    async sendDeleteCode(@Req() req: AccountRequest) {
        return this.userService.sendDeleteCode(req.user.id);
    }

    @Delete('me')
    @NeedAccount()
    @RateLimiter({ limit: 5, ttl: 60_000 })
    async deleteMe(
        @Body() dto: DeleteUserDto,
        @Req() req: FastifyRequest & { user: { id: number } },
        @Res({ passthrough: true }) res: FastifyReply,
    ) {
        await this.userService.deleteUser(
            req.user.id,
            dto.code,
            auditContextWithIp(this.sessionSecurity, req.ip),
        );
        res.clearCookie('refreshToken', refreshCookieOptions(this.configService));
        return { deleted: true };
    }
}
