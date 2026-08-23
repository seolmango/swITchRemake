import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from "./auth.controller";
import { JwtModule} from "@nestjs/jwt";
import { SessionModule } from '../session/session.module';
import { SanctionModule } from '../sanction/sanction.module';

@Module({
    controllers: [AuthController],
    providers: [AuthService],
    exports: [AuthService, JwtModule],
    imports: [JwtModule.register({}), SessionModule, SanctionModule]
})
export class AuthModule {}
