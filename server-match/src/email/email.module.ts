import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import { smtpOptions } from './smtp-options';
import { EMAIL_TRANSPORTER, EmailService } from './email.service';

@Global()
@Module({
    providers: [
        {
            provide: EMAIL_TRANSPORTER,
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => {
                const sender = configService.get<string>('SMTP_FROM') || configService.get<string>('SMTP_USER');
                const options = smtpOptions((name) => configService.get<string>(name));
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
