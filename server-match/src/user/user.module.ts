import { Module } from "@nestjs/common";
import { UserService } from "./user.service";
import { UserController } from "./user.controller";
import { SanctionModule } from '../sanction/sanction.module';

@Module({
    controllers: [UserController],
    providers: [UserService],
    exports: [UserService],
    imports: [SanctionModule],
})
export class UserModule {}
