import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from "./auth.controller";
import { JwtModule} from "@nestjs/jwt";
import { SessionModule } from '../session/session.module';
import { SanctionModule } from '../sanction/sanction.module';
import { ActorGuard } from './actor.guard';
import { AccountGuard } from './account.guard';
import { MfaModule } from '../mfa/mfa.module';

@Module({
    controllers: [AuthController],
    providers: [AuthService, ActorGuard, AccountGuard],
    exports: [AuthService, JwtModule],
    imports: [JwtModule.register({}), SessionModule, SanctionModule, MfaModule]
})
export class AuthModule {}
