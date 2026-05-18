import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from "./auth.service";
import { SendEmailDto } from "./dto/email-auth.dto";

@Controller('auth')
export class AuthController {
    constructor(
        private readonly authService: AuthService,
    ) {}

    @Post('verify')
    async sendVerificationEmail(@Body() sendEmailDto: SendEmailDto) {
        return this.authService.sendVerificationCodeEmail(sendEmailDto);
    }
}