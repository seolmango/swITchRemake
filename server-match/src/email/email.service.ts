import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';

@Injectable()
export class EmailService {
    private readonly logger = new Logger(EmailService.name);

    constructor(private readonly mailerService: MailerService) {}

    async sendRegistrationCodeEmail(to: string, signupToken: string): Promise<boolean> {
        try {
            await this.mailerService.sendMail({
                to,
                subject: '[swITch] 회원가입 계정 인증 코드',
                html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 500px; border: 1px solid #ddd; border-radius: 8px;">
            <h2 style="color: #333;">swITch 회원가입을 환영합니다!</h2>
            <p>아래의 인증 코드를 회원가입 화면에 입력하여 가입을 완료해 주세요.</p>
            <div style="background-color: #f4f4f4; padding: 15px; font-size: 24px; font-weight: bold; text-align: center; letter-spacing: 5px; margin: 20px 0;">
              ${signupToken}
            </div>
            <p style="color: #777; font-size: 12px;">본인이 요청하지 않으셨다면 이 메일을 무시해 주세요.</p>
            <p style="color: #777; font-size: 12px;">이 코드는 5분간 유효합니다.</p>
          </div>
        `,
            });
            return true;
        } catch (error) {
            this.logger.error(`Failed to send registration email to ${to}`, error);
            return false;
        }
    }

    async sendPasswordResetCodeEmail(to: string, code: string): Promise<boolean> {
        try {
            await this.mailerService.sendMail({
                to,
                subject: '[swITch] 비밀번호 재설정 인증 코드',
                html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 500px; border: 1px solid #ddd; border-radius: 8px;">
            <h2 style="color: #333;">swITch 비밀번호 재설정</h2>
            <p>요청하신 비밀번호 재설정 인증 코드입니다.</p>
            <div style="background-color: #f4f4f4; padding: 15px; font-size: 24px; font-weight: bold; text-align: center; letter-spacing: 5px; margin: 20px 0;">
              ${code}
            </div>
            <p style="color: #777; font-size: 12px;">본인이 요청하지 않으셨다면 이 메일을 무시해 주세요.</p>
            <p style="color: #777; font-size: 12px;">이 코드는 5분간 유효합니다.</p>
          </div>
        `,
            });
            return true;
        } catch (error) {
            this.logger.error(`Failed to send password reset email to ${to}`, error);
            return false;
        }
    }

    async sendDeleteAccountCodeEmail(to: string, code: string): Promise<boolean> {
        try {
            await this.mailerService.sendMail({
                to,
                subject: '[swITch] 회원 탈퇴 인증 코드',
                html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 500px; border: 1px solid #ddd; border-radius: 8px;">
            <h2 style="color: #333;">swITch 회원 탈퇴</h2>
            <p>요청하신 회원 탈퇴 인증 코드입니다.</p>
            <div style="background-color: #f4f4f4; padding: 15px; font-size: 24px; font-weight: bold; text-align: center; letter-spacing: 5px; margin: 20px 0;">
              ${code}
            </div>
            <p style="color: #777; font-size: 12px;">본인이 요청하지 않으셨다면 이 메일을 무시해 주세요.</p>
            <p style="color: #777; font-size: 12px;">이 코드는 5분간 유효합니다.</p>
          </div>
        `,
            });
            return true;
        } catch (error) {
            this.logger.error(`Failed to send delete account email to ${to}`, error);
            return false;
        }
    }
}