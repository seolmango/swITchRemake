import { Controller, Delete, Post, Body, Req, Res } from "@nestjs/common";
import { UserService } from "./user.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { RateLimiter } from "../ratelimiter.decorator";
import { NeedLogin } from '../auth/need-login.decorator';
import { DeleteUserDto } from './dto/delete-user.dto';
import { FastifyReply, FastifyRequest } from 'fastify';

@Controller('users')
export class UserController {
    constructor(
        private readonly userService: UserService,
    ) {}

    @Post('register')
    @RateLimiter({ anon: 5, user: 7, ttl: 60000 })
    async register(@Body() createUserDto: CreateUserDto) {
        return this.userService.createUser(createUserDto);
    }

    @Delete('me')
    @NeedLogin()
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
