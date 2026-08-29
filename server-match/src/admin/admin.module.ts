import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { RoomsModule } from '../rooms/rooms.module';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { PlayerLookupService } from './player-lookup.service';
import { AdminService } from './admin.service';
import { RequestMeterInterceptor } from './request-meter.interceptor';
import { RequestMeterService } from './request-meter.service';

@Module({
    imports: [DatabaseModule, RedisModule, RoomsModule],
    controllers: [AdminController],
    providers: [AdminService,
        AdminGuard,
        RequestMeterService,
        { provide: APP_INTERCEPTOR, useClass: RequestMeterInterceptor }, PlayerLookupService],
})
export class AdminModule {}
