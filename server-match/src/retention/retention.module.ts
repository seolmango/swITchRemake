import { Module } from '@nestjs/common';
import { RoomsModule } from '../rooms/rooms.module';
import { PublicConfigController } from '../config/public-config.controller';
import { RetentionService } from './retention.service';

@Module({
    imports: [RoomsModule],
    controllers: [PublicConfigController],
    providers: [RetentionService],
})
export class RetentionModule {}
