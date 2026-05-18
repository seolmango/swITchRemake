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