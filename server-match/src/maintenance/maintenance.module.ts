import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { MaintenanceService } from './maintenance.service';

@Global()
@Module({
    imports: [DatabaseModule, RedisModule],
    providers: [MaintenanceService],
    exports: [MaintenanceService],
})
export class MaintenanceModule {}
