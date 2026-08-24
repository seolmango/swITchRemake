import { Controller, Delete, Post, Body, Req, Res } from "@nestjs/common";
import { UserService } from "./user.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { RateLimiter } from "../ratelimiter.decorator";
import { NeedAccount } from '../auth/need-account.decorator';
import { DeleteUserDto } from './dto/delete-user.dto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { ChangePasswordDto } from './dto/change-password.dto';

@Controller('users')
export class UserController {
    constructor(
        private readonly userService: UserService,
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
        @Req() req: FastifyRequest & { user: { id: number; sessionId: string } },
    ) {
        return this.userService.changePassword(req.user.id, req.user.sessionId, dto);
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
        res.clearCookie('refreshToken', { path: '/' });
        return { deleted: true };
    }
}
