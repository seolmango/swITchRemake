import {Injectable, InternalServerErrorException, BadRequestException} from "@nestjs/common";
import {RedisService} from "../redis/redis.service";
import {EmailService} from "../email/email.service";
import {EmailAuthType, SendEmailDto} from "./dto/email-auth.dto";

@Injectable()
export class AuthService {
    constructor(
        private readonly redisService: RedisService,
        private readonly emailService: EmailService,
    ) {}

    async sendVerificationCodeEmail(dto: SendEmailDto) {
        const { email, vtype } = dto;

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const redisKey = `auth:code:${vtype}:${email}`;
        await this.redisService.set(redisKey, code, 300);

        let emailSent = false;
        switch (vtype) {
            case EmailAuthType.SIGNUP:
                emailSent = await this.emailService.sendRegistrationCodeEmail(email, code);
                break;
            case EmailAuthType.RESET_PASSWORD:
                emailSent = await this.emailService.sendPasswordResetCodeEmail(email, code);
                break;
            case EmailAuthType.DELETE:
                emailSent = await this.emailService.sendDeleteAccountCodeEmail(email, code);
                break;
        }
        if (!emailSent) {
            throw new InternalServerErrorException('Verification email send failed');
        }

        return {
            message: 'Verification code sent successfully',
        }
    }
}