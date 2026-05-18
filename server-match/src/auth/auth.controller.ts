import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from "./auth.service";
import { SendEmailDto } from "./dto/email-auth.dto";
import { LoginDto, RefreshTokenDto} from "./dto/login.dto";

@Controller('auth')
export class AuthController {
    constructor(
        private readonly authService: AuthService,
    ) {}

    @Post('verify')
    async sendVerificationEmail(@Body() sendEmailDto: SendEmailDto) {
        return this.authService.sendVerificationCodeEmail(sendEmailDto);
    }

    @Post('login')
    async login(@Body() loginDto: LoginDto) {
        return this.authService.login(loginDto);
    }

    @Post('refresh')
    async refresh(@Body() refreshDto: RefreshTokenDto) {
        return this.authService.refresh(refreshDto);
    }
}