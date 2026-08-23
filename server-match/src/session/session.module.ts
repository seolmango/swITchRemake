import { Module } from '@nestjs/common';
import { SessionController } from './session.controller';
import { SessionSecurityService } from './session-security.service';
import { SessionService } from './session.service';

@Module({
    controllers: [SessionController],
    providers: [SessionSecurityService, SessionService],
    exports: [SessionSecurityService, SessionService],
})
export class SessionModule {}
