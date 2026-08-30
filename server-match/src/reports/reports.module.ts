import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SanctionModule } from '../sanction/sanction.module';
import { RoomsModule } from '../rooms/rooms.module';
import { AdminReportsController } from './admin-reports.controller';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
    imports: [DatabaseModule, SanctionModule, RoomsModule],
    controllers: [ReportsController, AdminReportsController],
    providers: [ReportsService],
})
export class ReportsModule {}
