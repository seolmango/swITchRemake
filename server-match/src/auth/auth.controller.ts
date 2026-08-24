import { Controller, Post, Body, Res, Req, UnauthorizedException } from '@nestjs/common';
import { AuthService } from "./auth.service";
import { SendEmailDto } from "./dto/email-auth.dto";
import { LoginDto} from "./dto/login.dto";
import { RateLimiter } from "../ratelimiter.decorator";
import { FastifyReply, FastifyRequest } from "fastify";
import { ConfigService } from "@nestjs/config";
import { NeedActor } from './need-actor.decorator';

@Controller('auth')
export class AuthController {
    constructor(
        private readonly authService: AuthService,
        private readonly configService: ConfigService,
    ) {}

    @Post('verify')
    @RateLimiter({ anon: 5, guest: 5, account: 7, ttl: 60000 })
    async sendVerificationEmail(@Body() sendEmailDto: SendEmailDto) {
        return this.authService.sendVerificationCodeEmail(sendEmailDto);
    }

    @Post('login')
    @RateLimiter({ anon: 5, guest: 5, account: 7, ttl: 60000 })
    async login(
        @Body() loginDto: LoginDto,
        @Req() req: FastifyRequest,
        @Res({ passthrough: true }) res: FastifyReply,
    ) {
        await this.authService.assertIdentitySwitchAllowed(
            (req as FastifyRequest & { user?: { id: number | string } }).user?.id,
        );
        const { accessToken, refreshToken, nickname } = await this.authService.login(loginDto, {
            ip: req.ip,
            userAgent: this.userAgent(req),
        });

        res.setCookie('refreshToken', refreshToken, this.cookieOptions());

        return { accessToken, nickname };
    }

    @Post('refresh')
    @RateLimiter({ anon: 5, guest: 5, account: 7, ttl: 60000 })
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

        let tokens;
        try {
            tokens = await this.authService.refresh(unsignedCookie.value, {
                ip: req.ip,
                userAgent: this.userAgent(req),
            });
        } catch (error) {
            res.clearCookie('refreshToken', this.cookieOptions());
            throw error;
        }

        res.setCookie('refreshToken', tokens.refreshToken, this.cookieOptions());

        return { accessToken: tokens.accessToken, nickname: tokens.nickname };
    }

    @Post('guest')
    @RateLimiter({ anon: 5, guest: 0, account: 0, ttl: 60_000 })
    async guest(@Req() req: FastifyRequest) {
        return this.authService.createGuest(req.ip);
    }

    @Post('guest/refresh')
    @RateLimiter({ anon: 10, guest: 10, account: 0, ttl: 60_000 })
    async refreshGuest(@Body() body: { refreshToken?: string }) {
        if (typeof body?.refreshToken !== 'string' || body.refreshToken.length === 0) {
            throw new UnauthorizedException('No guest refresh token provided');
        }
        return this.authService.refreshGuest(body.refreshToken);
    }

    @Post('logout')
    @NeedActor()
    async logout(
        @Req() req: FastifyRequest & { user: { id: number | string; sessionId: string; guest: boolean } },
        @Res({ passthrough: true }) res: FastifyReply,
    ) {
        await this.authService.logout(req.user);
        res.clearCookie('refreshToken', this.cookieOptions());
        return { loggedOut: true };
    }

    private cookieOptions() {
        return {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict' as const,
            maxAge: Number(this.configService.get('JWT_REFRESH_EXPIRATION')),
            path: '/',
            signed: true,
        };
    }

    private userAgent(req: FastifyRequest): string | undefined {
        const value = req.headers['user-agent'];
        return Array.isArray(value) ? value[0] : value;
    }
}
