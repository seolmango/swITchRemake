import { Controller, Post, Body, Res, Req, UnauthorizedException } from '@nestjs/common';
import { AuthService } from "./auth.service";
import { SendEmailDto } from "./dto/email-auth.dto";
import { LoginDto} from "./dto/login.dto";
import { RateLimiter } from "../ratelimiter.decorator";
import { FastifyReply, FastifyRequest } from "fastify";
import { ConfigService } from "@nestjs/config";

@Controller('auth')
export class AuthController {
    constructor(
        private readonly authService: AuthService,
        private readonly configService: ConfigService,
    ) {}

    @Post('verify')
    @RateLimiter({ anon: 5, user: 7, ttl: 60000 })
    async sendVerificationEmail(@Body() sendEmailDto: SendEmailDto) {
        return this.authService.sendVerificationCodeEmail(sendEmailDto);
    }

    @Post('login')
    @RateLimiter({ anon: 5, user: 7, ttl: 60000 })
    async login(
        @Body() loginDto: LoginDto,
        @Res({ passthrough: true }) res: FastifyReply,
    ) {
        const { accessToken, refreshToken } = await this.authService.login(loginDto);

        res.setCookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: Number(this.configService.get('JWT_REFRESH_EXPIRATION')) * 1000,
            path: '/',
            signed: true,
        });

        return { accessToken };
    }

    @Post('refresh')
    @RateLimiter({ anon: 5, user: 7, ttl: 60000 })
    async refresh(
        @Req() req: FastifyRequest,
        @Res({ passthrough: true }) res: FastifyReply,
    ) {
        const rawCookie = req.cookies['refreshToken'];
        if (!rawCookie) {
            throw new UnauthorizedException('No refresh token provided');
        }

        const unsignedCookie = req.unsignCookie(rawCookie);
        if (!unsignedCookie.valid || !unsignedCookie.value) {
            throw new UnauthorizedException('Invalid refresh token provided');
        }

        const tokens = await this.authService.refresh(unsignedCookie.value);

        res.setCookie('refreshToken', tokens.refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: Number(this.configService.get('JWT_REFRESH_EXPIRATION')) * 1000,
            path: '/',
            signed: true,
        });

        return { accessToken: tokens.accessToken };
    }
}