import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from "./auth.service";
import { SendEmailDto } from "./dto/email-auth.dto";
import { LoginDto, RefreshTokenDto} from "./dto/login.dto";
import { RateLimiter } from "../ratelimiter.decorator";

@Controller('auth')
export class AuthController {
    constructor(
        private readonly authService: AuthService,
    ) {}

    @Post('verify')
    @RateLimiter({ anon: 5, user: 7, ttl: 60000 })
    async sendVerificationEmail(@Body() sendEmailDto: SendEmailDto) {
        return this.authService.sendVerificationCodeEmail(sendEmailDto);
    }

    @Post('login')
    @RateLimiter({ anon: 5, user: 7, ttl: 60000 })
    async login(@Body() loginDto: LoginDto) {
        return this.authService.login(loginDto);
    }

    @Post('refresh')
    @RateLimiter({ anon: 5, user: 7, ttl: 60000 })
    async refresh(@Body() refreshDto: RefreshTokenDto) {
        return this.authService.refresh(refreshDto);
    }
}