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
})
export class RoomsModule {}
