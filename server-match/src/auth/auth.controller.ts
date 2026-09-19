import { Controller, Post, Body, Res, Req, UnauthorizedException } from '@nestjs/common';
import { AuthService } from "./auth.service";
import { SendEmailDto } from "./dto/email-auth.dto";
import { LoginDto} from "./dto/login.dto";
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RateLimiter } from "../ratelimiter.decorator";
import { FastifyReply, FastifyRequest } from "fastify";
import { ConfigService } from "@nestjs/config";
import { NeedActor } from './need-actor.decorator';
import { refreshCookieOptions } from './refresh-cookie';
import { GuestRefreshDto } from './dto/guest-refresh.dto';
import { LoginMfaDto, LoginMfaEmailDto } from '../mfa/dto/login-mfa.dto';
import { TRUSTED_DEVICE_COOKIE, trustedDeviceCookieOptions } from '../mfa/trusted-device-cookie';
import { BlockDuringMaintenance } from '../maintenance/maintenance.decorator';
import { HumanChallengePurpose, IssueHumanChallengeDto, VerifyHumanChallengeDto } from './dto/human-challenge.dto';
import { HumanChallengeService } from './human-challenge.service';

@Controller('auth')
export class AuthController {
    constructor(
        private readonly authService: AuthService,
        private readonly configService: ConfigService,
        private readonly humanChallenges: HumanChallengeService,
    ) {}

    @Post('human-challenge')
    @RateLimiter({ limit: 12, ttl: 60_000 })
    issueHumanChallenge(@Body() dto: IssueHumanChallengeDto, @Req() req: FastifyRequest) {
        return this.humanChallenges.issue(dto.purpose, dto.subject, req.ip);
    }

    @Post('human-challenge/verify')
    @RateLimiter({ limit: 12, ttl: 60_000 })
    verifyHumanChallenge(@Body() dto: VerifyHumanChallengeDto, @Req() req: FastifyRequest) {
        return this.humanChallenges.verify(dto.challengeToken, dto.selectedSlot, req.ip);
    }

    @Post('verify')
    @RateLimiter({ limit: 5, ttl: 60000 })
    async sendVerificationEmail(@Body() sendEmailDto: SendEmailDto, @Req() req: FastifyRequest) {
        const purpose = sendEmailDto.vtype === 'signup'
            ? HumanChallengePurpose.SIGNUP
            : sendEmailDto.vtype === 'reset-password'
                ? HumanChallengePurpose.RESET_PASSWORD
                : HumanChallengePurpose.DELETE;
        await this.humanChallenges.consumeProof(sendEmailDto.humanProof, purpose, sendEmailDto.email, req.ip);
        return this.authService.sendVerificationCodeEmail(sendEmailDto);
    }

    @Post('password/reset')
    // 코드를 맞힐 때까지 두드리는 것을 막는다. 정상 사용자는 한 번이면 된다.
    @RateLimiter({ limit: 5, ttl: 60_000 })
    async resetPassword(@Body() dto: ResetPasswordDto) {
        return this.authService.resetPassword(dto);
    }

    @Post('login')
    @BlockDuringMaintenance()
    @RateLimiter({ limit: 5, ttl: 60000 })
    async login(
        @Body() loginDto: LoginDto,
        @Req() req: FastifyRequest,
        @Res({ passthrough: true }) res: FastifyReply,
    ) {
        await this.authService.assertIdentitySwitchAllowed(
            (req as FastifyRequest & { user?: { id: number | string } }).user?.id,
        );
        await this.humanChallenges.assertLoginAllowed(loginDto.email, req.ip, loginDto.humanProof);
        let result;
        try {
            result = await this.authService.login(loginDto, {
                ip: req.ip,
                userAgent: this.userAgent(req),
            }, this.readSignedCookie(req, TRUSTED_DEVICE_COOKIE));
        } catch (error) {
            if (error instanceof UnauthorizedException) {
                await this.humanChallenges.recordLoginFailure(loginDto.email, req.ip);
            }
            throw error;
        }
        await this.humanChallenges.clearLoginFailures(loginDto.email, req.ip);

        if (result.mfaRequired) return result;

        res.setCookie('refreshToken', result.refreshToken, this.cookieOptions());

        return { mfaRequired: false, accessToken: result.accessToken, nickname: result.nickname };
    }

    @Post('login/mfa')
    @BlockDuringMaintenance()
    @RateLimiter({ limit: 5, ttl: 60_000 })
    async completeMfaLogin(
        @Body() dto: LoginMfaDto,
        @Req() req: FastifyRequest,
        @Res({ passthrough: true }) res: FastifyReply,
    ) {
        await this.authService.assertIdentitySwitchAllowed(
            (req as FastifyRequest & { user?: { id: number | string } }).user?.id,
        );
        const result = await this.authService.completeMfaLogin(
            dto.challengeToken,
            dto.code,
            dto.trustDevice === true,
            { ip: req.ip, userAgent: this.userAgent(req) },
        );
        res.setCookie('refreshToken', result.refreshToken, this.cookieOptions());
        if (result.trustedDeviceToken) {
            res.setCookie(
                TRUSTED_DEVICE_COOKIE,
                result.trustedDeviceToken,
                trustedDeviceCookieOptions(this.configService),
            );
        }
        return {
            mfaRequired: false,
            accessToken: result.accessToken,
            nickname: result.nickname,
            trustedDeviceExpiresAt: result.trustedDeviceExpiresAt,
        };
    }

    @Post('login/mfa/email')
    @BlockDuringMaintenance()
    @RateLimiter({ limit: 5, ttl: 60_000 })
    resendMfaLoginEmail(@Body() dto: LoginMfaEmailDto) {
        return this.authService.resendLoginMfaEmail(dto.challengeToken);
    }

    @Post('refresh')
    @RateLimiter({ limit: 5, ttl: 60000 })
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
    @BlockDuringMaintenance()
    @RateLimiter({ limit: 5, ttl: 60_000 })
    async guest(@Req() req: FastifyRequest) {
        return this.authService.createGuest(req.ip);
    }

    @Post('guest/refresh')
    @RateLimiter({ limit: 5, ttl: 60_000 })
    async refreshGuest(@Body() body: GuestRefreshDto) {
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
        return refreshCookieOptions(this.configService);
    }

    private userAgent(req: FastifyRequest): string | undefined {
        const value = req.headers['user-agent'];
        return Array.isArray(value) ? value[0] : value;
    }

    private readSignedCookie(req: FastifyRequest, name: string): string | undefined {
        const raw = req.cookies[name];
        if (!raw) return undefined;
        const unsigned = req.unsignCookie(raw);
        return unsigned.valid && unsigned.value ? unsigned.value : undefined;
    }
}
