import { Module } from "@nestjs/common";
import { ReplayDownloadService } from './replay-download.service';
import { UserService } from "./user.service";
import { UserController } from "./user.controller";
import { SanctionModule } from '../sanction/sanction.module';
import { SessionModule } from '../session/session.module';
import { RoomsModule } from '../rooms/rooms.module';

@Module({
    controllers: [UserController],
    providers: [UserService, ReplayDownloadService],
    exports: [UserService],
    imports: [SanctionModule, SessionModule, RoomsModule],
})
export class UserModule {}
