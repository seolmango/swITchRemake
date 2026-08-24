import { Module } from "@nestjs/common";
import { UserService } from "./user.service";
import { UserController } from "./user.controller";
import { SanctionModule } from '../sanction/sanction.module';
import { SessionModule } from '../session/session.module';

@Module({
    controllers: [UserController],
    providers: [UserService],
    exports: [UserService],
    imports: [SanctionModule, SessionModule],
})
export class UserModule {}
