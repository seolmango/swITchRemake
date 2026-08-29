import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SanctionModule } from '../sanction/sanction.module';
import { AdminReportsController } from './admin-reports.controller';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
    imports: [DatabaseModule, SanctionModule],
    controllers: [ReportsController, AdminReportsController],
    providers: [ReportsService],
})
export class ReportsModule {}
