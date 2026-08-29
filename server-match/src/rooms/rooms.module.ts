import { Module } from '@nestjs/common';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';
import { ResultsModule } from '../results/results.module';
import { SessionModule } from '../session/session.module';
import { SanctionModule } from '../sanction/sanction.module';

@Module({
    imports: [ResultsModule, SessionModule, SanctionModule],
    controllers: [RoomsController],
    providers: [RoomsService],
    // 운영자 화면이 밀려 있는 제어 명령 수를 읽는다.
    exports: [RoomsService],
})
export class RoomsModule {}
