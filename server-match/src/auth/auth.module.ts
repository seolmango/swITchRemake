import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from "./auth.controller";
import { JwtModule} from "@nestjs/jwt";

@Module({
    controllers: [AuthController],
    providers: [AuthService],
    exports: [AuthService, JwtModule],
    imports: [JwtModule.register({})]
})
export class AuthModule {}