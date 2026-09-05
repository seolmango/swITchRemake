import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { SessionModule } from '../session/session.module';
import { MfaController } from './mfa.controller';
import { MfaSecurityService } from './mfa-security.service';
import { MfaService } from './mfa.service';

@Module({
    imports: [EmailModule, SessionModule],
    controllers: [MfaController],
    providers: [MfaSecurityService, MfaService],
    exports: [MfaSecurityService, MfaService],
})
export class MfaModule {}
