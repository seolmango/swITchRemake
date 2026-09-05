import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Transporter } from 'nodemailer';
import { RedisService } from '../redis/redis.service';

type EmailKind = 'signup' | 'reset-password' | 'delete' | 'mfa';
type EmailTransport = 'smtp' | 'sink';
export type EmailHealthStatus = 'ok' | 'checking' | 'unconfigured' | 'unreachable';

interface EmailTemplate { subject: string; heading: string; message: string; }

const EMAIL_TEMPLATES: Record<EmailKind, EmailTemplate> = {
    signup: { subject: '[swITch] 회원가입 계정 인증 코드', heading: 'swITch 회원가입을 환영합니다!', message: '아래의 인증 코드를 회원가입 화면에 입력하여 가입을 완료해 주세요.' },
    'reset-password': { subject: '[swITch] 비밀번호 재설정 인증 코드', heading: 'swITch 비밀번호 재설정', message: '요청하신 비밀번호 재설정 인증 코드입니다.' },
    delete: { subject: '[swITch] 회원 탈퇴 인증 코드', heading: 'swITch 회원 탈퇴', message: '요청하신 회원 탈퇴 인증 코드입니다.' },
    mfa: { subject: '[swITch] 2차 인증 코드', heading: 'swITch 2차 인증', message: '요청하신 2차 인증 코드입니다. 본인이 요청하지 않았다면 누구에게도 알려 주지 마세요.' },
};

export const EMAIL_TRANSPORTER = Symbol('EMAIL_TRANSPORTER');
type EmailTransporter = Pick<Transporter, 'sendMail' | 'verify'>;

@Injectable()
export class EmailService implements OnModuleInit {
    private readonly logger = new Logger(EmailService.name);
    private readonly transport: EmailTransport;
    private readonly smtpConfigured: boolean;
    private healthStatus: EmailHealthStatus = 'unconfigured';

    constructor(
        @Inject(EMAIL_TRANSPORTER) private readonly transporter: EmailTransporter,
        private readonly redisService: RedisService,
        configService: ConfigService,
    ) {
        const transport = configService.get<string>('EMAIL_TRANSPORT', 'sink');
        if (transport !== 'smtp' && transport !== 'sink') throw new Error('EMAIL_TRANSPORT must be either "smtp" or "sink".');
        if (configService.get<string>('APP_ENV') === 'prod' && transport === 'sink') {
            throw new Error('EMAIL_TRANSPORT=sink is not allowed when APP_ENV=prod. Use EMAIL_TRANSPORT=smtp.');
        }
        this.transport = transport;
        this.smtpConfigured = Boolean(
            configService.get<string>('SMTP_USER')?.trim()
            && configService.get<string>('SMTP_PASSWORD')?.trim(),
        );
    }

    onModuleInit(): void {
        // A sink must still reveal whether the configured SMTP server is reachable.
        // 의도적으로 await 하지 않는다. onModuleInit이 반환한 Promise는 Nest 부팅을 막고,
        // verify()는 SMTP가 닿지 않으면 nodemailer의 connectionTimeout(기본 2분)까지 매달린다.
        // 네트워크가 없는 CI나 방화벽 뒤에서 서버가 몇 분씩 안 뜨게 된다. 헬스 프로브는
        // 부팅 조건이 아니라 관측값이므로 결과가 나오는 대로 상태만 갈아끼운다.
        if (!this.smtpConfigured) return;
        this.healthStatus = 'checking';
        void this.transporter.verify().then(
            () => { this.healthStatus = 'ok'; },
            (error: unknown) => {
                this.healthStatus = 'unreachable';
                this.logger.error('SMTP transporter verification failed', error);
            },
        );
    }

    getHealthStatus(): EmailHealthStatus { return this.healthStatus; }

    async sendRegistrationCodeEmail(to: string, code: string): Promise<boolean> { return this.sendCodeEmail('signup', to, code); }
    async sendPasswordResetCodeEmail(to: string, code: string): Promise<boolean> { return this.sendCodeEmail('reset-password', to, code); }
    async sendDeleteAccountCodeEmail(to: string, code: string): Promise<boolean> { return this.sendCodeEmail('delete', to, code); }
    async sendMfaCodeEmail(to: string, code: string): Promise<boolean> { return this.sendCodeEmail('mfa', to, code); }

    private async sendCodeEmail(kind: EmailKind, to: string, code: string): Promise<boolean> {
        const template = EMAIL_TEMPLATES[kind];
        try {
            if (this.transport === 'sink') {
                // RedisService has no list operations; tests only need the newest code per address,
                // so one TTL-bound key intentionally overwrites earlier messages for that address.
                await this.redisService.set(`test:mail:${to}`, JSON.stringify({ kind, subject: template.subject, code, sentAt: new Date().toISOString() }), 600);
            } else {
                await this.transporter.sendMail({ to, subject: template.subject, html: this.renderHtml(template, code) });
            }
            return true;
        } catch (error) {
            this.logger.error(`Failed to deliver ${kind} email to ${to}`, error);
            return false;
        }
    }

    private renderHtml(template: EmailTemplate, code: string): string {
        return `<div style="font-family: Arial, sans-serif; padding: 20px; max-width: 500px; border: 1px solid #ddd; border-radius: 8px;">
            <h2 style="color: #333;">${template.heading}</h2><p>${template.message}</p>
            <div style="background-color: #f4f4f4; padding: 15px; font-size: 24px; font-weight: bold; text-align: center; letter-spacing: 5px; margin: 20px 0;">${code}</div>
            <p style="color: #777; font-size: 12px;">본인이 요청하지 않으셨다면 이 메일을 무시해 주세요.</p>
            <p style="color: #777; font-size: 12px;">이 코드는 5분간 유효합니다.</p></div>`;
    }
}
