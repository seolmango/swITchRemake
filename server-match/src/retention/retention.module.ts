import { Module } from '@nestjs/common';
import { RoomsModule } from '../rooms/rooms.module';
import { RetentionController } from './retention.controller';
import { RetentionService } from './retention.service';

@Module({
    imports: [RoomsModule],
    controllers: [RetentionController],
    providers: [RetentionService],
})
export class RetentionModule {}
