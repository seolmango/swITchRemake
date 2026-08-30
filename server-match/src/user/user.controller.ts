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

type AccountRequest = FastifyRequest & { user: { id: number; sessionId: string; guest: false } };

@Controller('users')
export class UserController {
    constructor(
        private readonly userService: UserService,
        private readonly replayDownload: ReplayDownloadService,
        private readonly configService: ConfigService,
    ) {}

    @Post('register')
    @RateLimiter({ anon: 5, guest: 5, account: 7, ttl: 60000 })
    async register(@Body() createUserDto: CreateUserDto) {
        return this.userService.createUser(createUserDto);
    }

    @Post('me/password')
    @NeedAccount()
    @RateLimiter({ anon: 0, guest: 5, account: 5, ttl: 60000 })
    async changePassword(
        @Body() dto: ChangePasswordDto,
        @Req() req: AccountRequest,
    ) {
        return this.userService.changePassword(req.user.id, req.user.sessionId, dto);
    }

    @Get('me/stats')
    @NeedAccount()
    @RateLimiter({ anon: 0, guest: 60, account: 120, ttl: 60_000 })
    async getMyStats(@Req() req: AccountRequest) {
        return this.userService.getStats(req.user.id);
    }

    @Get('me/matches')
    @NeedAccount()
    @RateLimiter({ anon: 0, guest: 60, account: 120, ttl: 60_000 })
    async getMyMatches(
        @Req() req: AccountRequest,
        @Query() query: MatchHistoryQueryDto,
    ) {
        return this.userService.getMatches(req.user.id, query.limit, query.cursor);
    }

    /**
     * 리플레이를 받아 갈 표를 끊는다.
     *
     * 파일을 여기서 흘려보내지 않는다 — 수백 KB가 매칭 서버를 통과할 이유가 없고, 파일은
     * 인게임 서버 디스크에 있다. 표만 주고 주소를 알려 준다.
     */
    @Post('me/matches/:matchId/replay-ticket')
    @NeedAccount()
    @RateLimiter({ anon: 0, guest: 0, account: 20, ttl: 60_000 })
    async createReplayTicket(@Req() req: AccountRequest, @Param('matchId', new ParseUUIDPipe()) matchId: string) {
        return this.replayDownload.createTicket(req.user.id, matchId);
    }

    @Post('me/delete-code')
    @NeedAccount()
    @RateLimiter({ anon: 0, guest: 0, account: 5, ttl: 60_000 })
    async sendDeleteCode(@Req() req: AccountRequest) {
        return this.userService.sendDeleteCode(req.user.id);
    }

    @Delete('me')
    @NeedAccount()
    async deleteMe(
        @Body() dto: DeleteUserDto,
        @Req() req: FastifyRequest & { user: { id: number } },
        @Res({ passthrough: true }) res: FastifyReply,
    ) {
        await this.userService.deleteUser(req.user.id, dto.code, {
            ip: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
        });
        res.clearCookie('refreshToken', refreshCookieOptions(this.configService));
        return { deleted: true };
    }
}
