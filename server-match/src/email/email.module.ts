import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool';
import { EMAIL_TRANSPORTER, EmailService } from './email.service';

@Global()
@Module({
    providers: [
        {
            provide: EMAIL_TRANSPORTER,
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => {
                const sender = configService.get<string>('SMTP_USER');
                const options: SMTPPool.Options = {
                    host: 'smtp.gmail.com',
                    port: 465,
                    secure: true,
                    pool: true,
                    maxConnections: 5,
                    // nodemailer 기본값(connection 2분, greeting 30초)은 인증 코드 메일에 너무 길다.
                    // 사용자는 그 사이 화면 앞에서 기다린다. 못 보내면 빨리 실패하는 편이 낫다.
                    connectionTimeout: 10_000,
                    greetingTimeout: 10_000,
                    socketTimeout: 20_000,
                    auth: {
                        user: sender,
                        pass: configService.get<string>('SMTP_PASSWORD'),
                    },
                };
                return createTransport(
                    options,
                    { from: `"swITch 운영팀" <${sender}>` },
                );
            },
        },
        EmailService,
    ],
    exports: [EmailService],
})
export class EmailModule {}
