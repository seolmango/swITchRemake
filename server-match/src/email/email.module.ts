import { Module, Global } from '@nestjs/common';
import { MailerModule } from '@nestjs-modules/mailer';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';

@Global()
@Module({
    imports: [
        MailerModule.forRootAsync({
            useFactory: (configService: ConfigService) => ({
                transport: {
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
                        user: configService.get<string>('SMTP_USER'),
                        pass: configService.get<string>('SMTP_PASSWORD'),
                    },
                },
                defaults: {
                    from: `"swITch 운영팀" <${configService.get<string>('SMTP_USER')}>`,
                },
            }),
            inject: [ConfigService],
        }),
    ],
    providers: [EmailService],
    exports: [EmailService],
})
export class EmailModule {}