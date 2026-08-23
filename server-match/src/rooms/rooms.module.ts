import { Module } from '@nestjs/common';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';
import { ResultsModule } from '../results/results.module';
import { SessionModule } from '../session/session.module';

@Module({
    imports: [ResultsModule, SessionModule],
    controllers: [RoomsController],
    providers: [RoomsService],
})
export class RoomsModule {}
