import { Module } from '@nestjs/common';
import { RoomsModule } from '../rooms/rooms.module';
import { RetentionService } from './retention.service';

@Module({
    imports: [RoomsModule],
    providers: [RetentionService],
})
export class RetentionModule {}
