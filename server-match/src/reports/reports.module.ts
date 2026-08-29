import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AdminReportsController } from './admin-reports.controller';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
    imports: [DatabaseModule],
    controllers: [ReportsController, AdminReportsController],
    providers: [ReportsService],
})
export class ReportsModule {}
